// What Bun's forks of uSockets and uWebSockets call into and Beyond does not
// build yet: TLS (BoringSSL, vendor/bun-usockets/src/crypto), server name
// indication, HPACK (ls-hpack, for HTTP/2). Beyond creates no TLS context and
// does not negotiate HTTP/2, so none of these runs; each fails loudly if it
// does.

#include <stdio.h>
#include <stdlib.h>

#define UNSUPPORTED(name)                                                           \
    __attribute__((noreturn)) void name(void) {                                     \
        fputs("beyond: " #name " (TLS and HTTP/2 are not supported yet)\n", stderr); \
        abort();                                                                    \
    }

// Called for every socket, listen socket and loop: without TLS, nothing to do.
void us_internal_free_loop_ssl_data(void *loop) { (void)loop; }
void us_internal_listen_socket_ssl_free(void *ls) { (void)ls; }
void us_internal_ssl_detach(void *s) { (void)s; }

UNSUPPORTED(us_internal_ssl_attach)
UNSUPPORTED(us_internal_ssl_close)
UNSUPPORTED(us_internal_ssl_ctx_unref)
UNSUPPORTED(us_internal_ssl_ctx_up_ref)
UNSUPPORTED(us_internal_ssl_fatal_write_error)
UNSUPPORTED(us_internal_ssl_get_native_handle)
UNSUPPORTED(us_internal_ssl_handshake_callback_has_fired)
UNSUPPORTED(us_internal_ssl_is_handshake_finished)
UNSUPPORTED(us_internal_ssl_is_low_prio)
UNSUPPORTED(us_internal_ssl_is_shut_down)
UNSUPPORTED(us_internal_ssl_on_close)
UNSUPPORTED(us_internal_ssl_on_data)
UNSUPPORTED(us_internal_ssl_on_end)
UNSUPPORTED(us_internal_ssl_on_end_after_rejected_send)
UNSUPPORTED(us_internal_ssl_on_open)
UNSUPPORTED(us_internal_ssl_on_timeout)
UNSUPPORTED(us_internal_ssl_on_writable)
UNSUPPORTED(us_internal_ssl_shutdown)
UNSUPPORTED(us_internal_ssl_sni_servername)
UNSUPPORTED(us_internal_ssl_socket_relocated)
UNSUPPORTED(us_internal_ssl_spill_pending)
UNSUPPORTED(us_internal_ssl_verify_error)
UNSUPPORTED(us_internal_ssl_write)
UNSUPPORTED(us_internal_ssl_writev)
UNSUPPORTED(us_listen_socket_add_server_name)
UNSUPPORTED(us_listen_socket_find_server_name_ctx)
UNSUPPORTED(us_listen_socket_on_server_name)
UNSUPPORTED(us_socket_alpn_is_h2)
UNSUPPORTED(us_socket_server_name_reject_unauthorized)
UNSUPPORTED(us_socket_server_name_userdata)
UNSUPPORTED(us_ssl_ctx_enable_http2_alpn)
UNSUPPORTED(us_ssl_ctx_from_options)
UNSUPPORTED(us_ssl_ctx_set_sni_policy)
UNSUPPORTED(lshpack_enc_init)
UNSUPPORTED(lshpack_enc_cleanup)
UNSUPPORTED(lshpack_enc_encode)
UNSUPPORTED(lshpack_enc_set_max_capacity)
UNSUPPORTED(lshpack_enc_use_hist)
UNSUPPORTED(lshpack_dec_init)
UNSUPPORTED(lshpack_dec_cleanup)
UNSUPPORTED(lshpack_dec_decode)
