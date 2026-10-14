/* Beyond: what Bun's uWebSockets uses of simdutf (through WebKit's WTF):
   UTF-8 validation of WebSocket text frames. */
#pragma once
#include <stddef.h>
#include <stdint.h>
namespace simdutf {
inline bool validate_utf8(const char *buf, size_t len) {
    const unsigned char *s = (const unsigned char *)buf, *end = s + len;
    while (s < end) {
        unsigned char c = *s;
        if (c < 0x80) { s++; continue; }
        size_t n; uint32_t cp, min;
        if ((c & 0xE0) == 0xC0) { n = 1; cp = c & 0x1F; min = 0x80; }
        else if ((c & 0xF0) == 0xE0) { n = 2; cp = c & 0x0F; min = 0x800; }
        else if ((c & 0xF8) == 0xF0) { n = 3; cp = c & 0x07; min = 0x10000; }
        else return false;
        if ((size_t)(end - s) <= n) return false;
        for (size_t i = 1; i <= n; i++) {
            if ((s[i] & 0xC0) != 0x80) return false;
            cp = (cp << 6) | (s[i] & 0x3F);
        }
        if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return false;
        s += n + 1;
    }
    return true;
}
}
