// The networking stack alone: an HTTP server on Bun's uWebSockets (no
// JavaScript), as a check of the vendored code and Beyond's hooks.
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include "libusockets.h"

// The functions of Bun's C interface to uWebSockets (vendor/uws-capi) used here.
typedef struct uws_app_s uws_app_t;
typedef struct uws_req_s uws_req_t;
typedef struct uws_res_s uws_res_t;
typedef void (*uws_method_handler)(uws_res_t *res, uws_req_t *req, void *user_data);
typedef void (*uws_listen_handler)(struct us_listen_socket_t *listen_socket, void *user_data);
uws_app_t *uws_create_app(int ssl, struct us_bun_socket_context_options_t options);
void uws_app_get(int ssl, uws_app_t *app, const char *pattern, size_t pattern_len, uws_method_handler handler, void *user);
void uws_app_listen_with_config(int ssl, uws_app_t *app, const char *host, uint16_t port, int32_t options,
                                uws_listen_handler handler, void *user);
void uws_res_end(int ssl, uws_res_t *res, const char *data, size_t length, bool close_connection);
struct us_loop_t *uws_get_loop(void);

static void on_get(uws_res_t *res, uws_req_t *req, void *user) {
    (void)req, (void)user;
    uws_res_end(0, res, "Hello from Beyond!", 18, false);
}

static void on_listen(struct us_listen_socket_t *ls, void *user) {
    (void)user;
    printf(ls ? "listening\n" : "listen failed\n");
    fflush(stdout);
}

int main(void) {
    struct us_bun_socket_context_options_t options;
    memset(&options, 0, sizeof options);
    uws_app_t *app = uws_create_app(0, options);
    uws_app_get(0, app, "/*", 2, on_get, NULL);
    uws_app_listen_with_config(0, app, "127.0.0.1", 3901, 0, on_listen, NULL);
    us_loop_run(uws_get_loop());
    return 0;
}
