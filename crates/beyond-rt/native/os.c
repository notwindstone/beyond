// node:os's natives (lib/node/internal/bindings/node_os.ts): what Bun's
// node_os.rs asks the system (Linux), the binding making Bun's values and
// errors of them.

#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <ifaddrs.h>
#include <limits.h>
#include <linux/if_packet.h>
#include <net/if.h>
#include <netinet/in.h>
#include <pwd.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/sysinfo.h>
#include <sys/utsname.h>
#include <unistd.h>

#include "quickjs.h"

// A small file's content (at most cap - 1 bytes, NUL-terminated): its
// length, or -1.
static ssize_t read_small(const char *path, char *buf, size_t cap) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0)
        return -1;
    size_t n = 0;
    while (n + 1 < cap) {
        ssize_t r = read(fd, buf + n, cap - 1 - n);
        if (r < 0 && errno == EINTR)
            continue;
        if (r <= 0)
            break;
        n += (size_t)r;
    }
    close(fd);
    buf[n] = 0;
    return (ssize_t)n;
}

// A whole file of /proc (whose size stat does not tell), js_malloc'd.
static char *read_proc(JSContext *c, const char *path, size_t *len) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0)
        return NULL;
    size_t cap = 16384, n = 0;
    char *buf = js_malloc(c, cap);
    for (; buf;) {
        if (n + 1 >= cap) {
            char *nb = js_realloc(c, buf, cap * 2);
            if (!nb) {
                js_free(c, buf);
                buf = NULL;
                break;
            }
            buf = nb;
            cap *= 2;
        }
        ssize_t r = read(fd, buf + n, cap - 1 - n);
        if (r < 0 && errno == EINTR)
            continue;
        if (r <= 0)
            break;
        n += (size_t)r;
    }
    close(fd);
    if (buf) {
        buf[n] = 0;
        *len = n;
    }
    return buf;
}

// osTotalmem().
static JSValue js_os_totalmem(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    struct sysinfo info;
    if (sysinfo(&info) != 0)
        return JS_NewInt32(c, 0);
    return JS_NewFloat64(c, (double)((uint64_t)info.totalram * info.mem_unit));
}

// osFreemem(): /proc/meminfo's MemAvailable, else sysinfo's freeram (as
// libuv's uv_get_free_memory).
static JSValue js_os_freemem(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    char buf[8192];
    if (read_small("/proc/meminfo", buf, sizeof buf) > 0) {
        char *p = strstr(buf, "MemAvailable:");
        if (p) {
            unsigned long long kb = strtoull(p + 13, NULL, 10);
            if (kb)
                return JS_NewFloat64(c, (double)kb * 1024);
        }
    }
    struct sysinfo info;
    if (sysinfo(&info) != 0)
        return JS_NewInt32(c, 0);
    return JS_NewFloat64(c, (double)((uint64_t)info.freeram * info.mem_unit));
}

// osUptime(): whole seconds.
static JSValue js_os_uptime(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    struct sysinfo info;
    if (sysinfo(&info) != 0)
        return JS_NewInt32(c, 0);
    return JS_NewFloat64(c, (double)info.uptime);
}

// osLoadavg(): [1, 5, 15 minutes], rounded up to hundredths (Bun's).
static JSValue js_os_loadavg(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    double l[3] = {0, 0, 0};
    struct sysinfo info;
    if (sysinfo(&info) == 0) {
        for (int i = 0; i < 3; i++) {
            double v = (double)info.loads[i] / 65536.0 * 100.0;
            double f = (double)(long long)v;
            l[i] = (v > f ? f + 1 : f) / 100.0;
        }
    }
    JSValue a = JS_NewArray(c);
    for (int i = 0; i < 3; i++)
        JS_SetPropertyUint32(c, a, i, JS_NewFloat64(c, l[i]));
    return a;
}

// osUname(field): 0 the hostname (gethostname's), 1 the release, 2 the
// version, 3 the machine.
static JSValue js_os_uname(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t field = 0;
    JS_ToInt32(c, &field, argv[0]);
    if (field == 0) {
        char name[HOST_NAME_MAX + 1];
        if (gethostname(name, sizeof name) != 0)
            return JS_NewString(c, "unknown");
        name[HOST_NAME_MAX] = 0;
        return JS_NewString(c, name);
    }
    struct utsname u;
    if (uname(&u) != 0)
        return JS_NewString(c, "unknown");
    return JS_NewString(c, field == 1 ? u.release : field == 2 ? u.version : u.machine);
}

// osHomedir(): $HOME, else the user's passwd entry's; or the errno
// (uv_os_homedir's, ENOENT when there is no entry).
static JSValue js_os_homedir(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *home = getenv("HOME");
    if (home && *home)
        return JS_NewString(c, home);
    size_t cap = 4096;
    char *buf = NULL;
    struct passwd pw, *result = NULL;
    int ret;
    for (;;) {
        char *nb = realloc(buf, cap);
        if (!nb) {
            free(buf);
            return JS_NewInt32(c, ENOMEM);
        }
        buf = nb;
        ret = getpwuid_r(geteuid(), &pw, buf, cap, &result);
        if (ret == EINTR)
            continue;
        if (ret == ERANGE) {
            cap *= 2;
            continue;
        }
        break;
    }
    JSValue r;
    if (ret != 0)
        r = JS_NewInt32(c, ret);
    else if (!result)
        r = JS_NewInt32(c, ENOENT);
    else
        r = JS_NewString(c, pw.pw_dir ? pw.pw_dir : "");
    free(buf);
    return r;
}

// osGetPriority(pid): the priority, or null (ESRCH).
static JSValue js_os_get_priority(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t pid = 0;
    JS_ToInt32(c, &pid, argv[0]);
    errno = 0;
    int p = getpriority(PRIO_PROCESS, pid);
    if (p == -1 && errno != 0)
        return JS_NULL;
    return JS_NewInt32(c, p);
}

// osSetPriority(pid, priority): 0, or the errno.
static JSValue js_os_set_priority(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t pid = 0, prio = 0;
    JS_ToInt32(c, &pid, argv[0]);
    JS_ToInt32(c, &prio, argv[1]);
    if (pid < 0)
        return JS_NewInt32(c, ESRCH);
    return JS_NewInt32(c, setpriority(PRIO_PROCESS, pid, prio) == 0 ? 0 : errno);
}

// osIds(): [uid, gid, the number of processors online (at least 1)].
static JSValue js_os_ids(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JSValue a = JS_NewArray(c);
    long n = sysconf(_SC_NPROCESSORS_ONLN);
    JS_SetPropertyUint32(c, a, 0, JS_NewUint32(c, getuid()));
    JS_SetPropertyUint32(c, a, 1, JS_NewUint32(c, getgid()));
    JS_SetPropertyUint32(c, a, 2, JS_NewInt32(c, n < 1 ? 1 : (int32_t)n));
    return a;
}

// osCpus(): [{model, speed, times: {user, nice, sys, idle, irq}}] as Bun's
// cpus_impl_linux (times of /proc/stat in ms, models of /proc/cpuinfo, the
// speed in MHz of cpufreq); null when /proc/cpuinfo names a processor
// /proc/stat does not have; undefined when /proc/stat cannot be read.
static JSValue js_os_cpus(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    size_t len;
    char *stat = read_proc(c, "/proc/stat", &len);
    if (!stat)
        return JS_UNDEFINED;
    JSValue arr = JS_NewArray(c);
    uint32_t n = 0;
    char *save = NULL;
    char *line = strtok_r(stat, "\n", &save);
    // (The first line is all of them.)
    for (line = line ? strtok_r(NULL, "\n", &save) : NULL; line; line = strtok_r(NULL, "\n", &save)) {
        if (strncmp(line, "cpu", 3) != 0)
            break;
        unsigned long long v[6] = {0};
        char *p = line;
        while (*p && *p != ' ' && *p != '\t')
            p++;
        for (int i = 0; i < 6; i++)
            v[i] = strtoull(p, &p, 10);
        JSValue cpu = JS_NewObject(c);
        JSValue t = JS_NewObject(c);
        JS_SetPropertyStr(c, t, "user", JS_NewFloat64(c, (double)(v[0] * 10)));
        JS_SetPropertyStr(c, t, "nice", JS_NewFloat64(c, (double)(v[1] * 10)));
        JS_SetPropertyStr(c, t, "sys", JS_NewFloat64(c, (double)(v[2] * 10)));
        JS_SetPropertyStr(c, t, "idle", JS_NewFloat64(c, (double)(v[3] * 10)));
        JS_SetPropertyStr(c, t, "irq", JS_NewFloat64(c, (double)(v[5] * 10)));
        JS_SetPropertyStr(c, cpu, "times", t);
        JS_SetPropertyUint32(c, arr, n++, cpu);
    }
    js_free(c, stat);
    char *info = read_proc(c, "/proc/cpuinfo", &len);
    if (info) {
        int64_t index = -1;
        int has_model = 1;
        save = NULL;
        for (line = strtok_r(info, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
            if (strncmp(line, "processor\t: ", 12) == 0) {
                if (!has_model && index >= 0) {
                    JSValue cpu = JS_GetPropertyUint32(c, arr, (uint32_t)index);
                    JS_SetPropertyStr(c, cpu, "model", JS_NewString(c, "unknown"));
                    JS_FreeValue(c, cpu);
                }
                index = strtoll(line + 12, NULL, 10);
                if (index >= n) {
                    js_free(c, info);
                    JS_FreeValue(c, arr);
                    return JS_NULL;
                }
                has_model = 0;
            } else if (strncmp(line, "model name\t: ", 13) == 0 && index >= 0) {
                JSValue cpu = JS_GetPropertyUint32(c, arr, (uint32_t)index);
                JS_SetPropertyStr(c, cpu, "model", JS_NewString(c, line + 13));
                JS_FreeValue(c, cpu);
                has_model = 1;
            }
        }
        if (!has_model && index >= 0) {
            JSValue cpu = JS_GetPropertyUint32(c, arr, (uint32_t)index);
            JS_SetPropertyStr(c, cpu, "model", JS_NewString(c, "unknown"));
            JS_FreeValue(c, cpu);
        }
        js_free(c, info);
    } else {
        for (uint32_t i = 0; i < n; i++) {
            JSValue cpu = JS_GetPropertyUint32(c, arr, i);
            JS_SetPropertyStr(c, cpu, "model", JS_NewString(c, "unknown"));
            JS_FreeValue(c, cpu);
        }
    }
    for (uint32_t i = 0; i < n; i++) {
        char path[128], buf[64];
        snprintf(path, sizeof path, "/sys/devices/system/cpu/cpu%u/cpufreq/scaling_cur_freq", i);
        double speed = 0;
        if (read_small(path, buf, sizeof buf) > 0)
            speed = (double)(strtoull(buf, NULL, 10) / 1000);
        JSValue cpu = JS_GetPropertyUint32(c, arr, i);
        JS_SetPropertyStr(c, cpu, "speed", JS_NewFloat64(c, speed));
        JS_FreeValue(c, cpu);
    }
    return arr;
}

static int iface_skip(const struct ifaddrs *a) {
    return !(a->ifa_flags & IFF_RUNNING) || !(a->ifa_flags & IFF_UP) || !a->ifa_addr;
}

static int iface_link(const struct ifaddrs *a) {
    return a->ifa_addr && a->ifa_addr->sa_family == AF_PACKET;
}

static void format_ip(const struct sockaddr *sa, char *out, size_t cap) {
    out[0] = 0;
    if (!sa)
        return;
    if (sa->sa_family == AF_INET)
        inet_ntop(AF_INET, &((const struct sockaddr_in *)sa)->sin_addr, out, cap);
    else if (sa->sa_family == AF_INET6)
        inet_ntop(AF_INET6, &((const struct sockaddr_in6 *)sa)->sin6_addr, out, cap);
}

// The prefix length of a netmask's bytes, or -1 when its ones are not
// contiguous from the left.
static int cidr_suffix(const uint8_t *m, int n) {
    int bits = 0, i = 0;
    for (; i < n && m[i] == 0xff; i++)
        bits += 8;
    if (i < n) {
        uint8_t b = m[i];
        while (b & 0x80) {
            bits++;
            b <<= 1;
        }
        if (b)
            return -1;
        for (i++; i < n; i++)
            if (m[i])
                return -1;
    }
    return bits;
}

// osNetworkInterfaces(): Bun's network_interfaces_posix, or the errno of
// getifaddrs.
static JSValue js_os_network_interfaces(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    struct ifaddrs *start;
    if (getifaddrs(&start) != 0)
        return JS_NewInt32(c, errno);
    JSValue ret = JS_NewObject(c);
    for (struct ifaddrs *it = start; it; it = it->ifa_next) {
        if (iface_skip(it) || iface_link(it))
            continue;
        int family = it->ifa_addr->sa_family;
        JSValue o = JS_NewObject(c);
        char addr[INET6_ADDRSTRLEN + 8], mask[INET6_ADDRSTRLEN + 8];
        format_ip(it->ifa_addr, addr, sizeof addr - 4);
        format_ip(it->ifa_netmask, mask, sizeof mask);
        int suffix = -1;
        if (it->ifa_netmask && family == AF_INET)
            suffix = cidr_suffix((const uint8_t *)&((const struct sockaddr_in *)it->ifa_netmask)->sin_addr, 4);
        else if (it->ifa_netmask && family == AF_INET6)
            suffix = cidr_suffix(((const struct sockaddr_in6 *)it->ifa_netmask)->sin6_addr.s6_addr, 16);
        JS_SetPropertyStr(c, o, "address", JS_NewString(c, addr));
        if (suffix >= 0) {
            char cidr[INET6_ADDRSTRLEN + 8];
            snprintf(cidr, sizeof cidr, "%s/%d", addr, suffix);
            JS_SetPropertyStr(c, o, "cidr", JS_NewString(c, cidr));
        } else {
            JS_SetPropertyStr(c, o, "cidr", JS_NULL);
        }
        JS_SetPropertyStr(c, o, "netmask", JS_NewString(c, mask));
        JS_SetPropertyStr(c, o, "family",
                          JS_NewString(c, family == AF_INET ? "IPv4" : family == AF_INET6 ? "IPv6" : "unknown"));
        // (The MAC address: of the link-layer entry of the same name, or of
        // the name before a `:`.)
        char mac[18] = "00:00:00:00:00:00";
        size_t nl = strlen(it->ifa_name);
        for (struct ifaddrs *ll = start; ll; ll = ll->ifa_next) {
            if (iface_skip(ll) || !iface_link(ll))
                continue;
            if (strncmp(ll->ifa_name, it->ifa_name, nl) != 0)
                continue;
            if (strlen(ll->ifa_name) > nl && ll->ifa_name[nl] != ':')
                continue;
            const struct sockaddr_ll *sl = (const struct sockaddr_ll *)ll->ifa_addr;
            if (sl->sll_halen >= 6) {
                const uint8_t *m = sl->sll_addr;
                snprintf(mac, sizeof mac, "%02x:%02x:%02x:%02x:%02x:%02x", m[0], m[1], m[2], m[3], m[4], m[5]);
            }
            break;
        }
        JS_SetPropertyStr(c, o, "mac", JS_NewString(c, mac));
        JS_SetPropertyStr(c, o, "internal", JS_NewBool(c, (it->ifa_flags & IFF_LOOPBACK) != 0));
        if (family == AF_INET6)
            JS_SetPropertyStr(c, o, "scopeid",
                              JS_NewUint32(c, ((const struct sockaddr_in6 *)it->ifa_addr)->sin6_scope_id));
        JSValue list = JS_GetPropertyStr(c, ret, it->ifa_name);
        if (JS_IsArray(list)) {
            int64_t len = 0;
            JS_GetLength(c, list, &len);
            JS_SetPropertyInt64(c, list, len, o);
            JS_FreeValue(c, list);
        } else {
            JS_FreeValue(c, list);
            list = JS_NewArray(c);
            JS_SetPropertyUint32(c, list, 0, o);
            JS_SetPropertyStr(c, ret, it->ifa_name, list);
        }
    }
    freeifaddrs(start);
    return ret;
}

const JSCFunctionListEntry beyond_os_functions[] = {
    JS_CFUNC_DEF("osTotalmem", 0, js_os_totalmem),
    JS_CFUNC_DEF("osFreemem", 0, js_os_freemem),
    JS_CFUNC_DEF("osUptime", 0, js_os_uptime),
    JS_CFUNC_DEF("osLoadavg", 0, js_os_loadavg),
    JS_CFUNC_DEF("osUname", 1, js_os_uname),
    JS_CFUNC_DEF("osHomedir", 0, js_os_homedir),
    JS_CFUNC_DEF("osGetPriority", 1, js_os_get_priority),
    JS_CFUNC_DEF("osSetPriority", 2, js_os_set_priority),
    JS_CFUNC_DEF("osIds", 0, js_os_ids),
    JS_CFUNC_DEF("osCpus", 0, js_os_cpus),
    JS_CFUNC_DEF("osNetworkInterfaces", 0, js_os_network_interfaces),
};

const int beyond_os_function_count = sizeof beyond_os_functions / sizeof *beyond_os_functions;
