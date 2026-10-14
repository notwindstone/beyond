/* Beyond: the interface of ls-hpack (HPACK, for HTTP/2) that Bun's
   uWebSockets compiles against. Beyond does not serve HTTP/2 yet: the
   functions (native/stubs.c) fail. */
#pragma once
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#ifndef LSXPACK_MAX_STRLEN
#define LSXPACK_MAX_STRLEN UINT16_MAX
#endif
typedef uint16_t lsxpack_strlen_t;

struct lsxpack_header {
    char *buf;
    uint32_t name_hash;
    uint32_t nameval_hash;
    lsxpack_strlen_t name_offset;
    lsxpack_strlen_t name_len;
    lsxpack_strlen_t val_offset;
    lsxpack_strlen_t val_len;
    uint16_t chain_next_idx;
    uint8_t hpack_index;
    uint8_t qpack_index;
    uint8_t app_index;
    uint8_t flags;
    uint8_t indexed_type;
    uint8_t dec_overhead;
};
typedef struct lsxpack_header lsxpack_header_t;

enum lshpack_static_hdr_idx {
    LSHPACK_HDR_UNKNOWN,
    LSHPACK_HDR_AUTHORITY,
    LSHPACK_HDR_METHOD_GET,
    LSHPACK_HDR_METHOD_POST,
    LSHPACK_HDR_PATH,
    LSHPACK_HDR_PATH_INDEX_HTML,
    LSHPACK_HDR_SCHEME_HTTP,
    LSHPACK_HDR_SCHEME_HTTPS,
    LSHPACK_HDR_CONTENT_LENGTH = 28,
    LSHPACK_HDR_EXPECT = 35,
    LSHPACK_HDR_HOST = 38,
    LSHPACK_HDR_TRANSFER_ENCODING = 57,
};

#define LSHPACK_OK 0
#define LSHPACK_ERR_BAD_DATA (-1)
#define LSHPACK_ERR_TOO_LARGE (-2)
#define LSHPACK_ERR_MORE_BUF (-3)

struct lshpack_enc { void *state[16]; };
struct lshpack_dec { void *state[16]; };

int lshpack_enc_init(struct lshpack_enc *);
void lshpack_enc_cleanup(struct lshpack_enc *);
unsigned char *lshpack_enc_encode(struct lshpack_enc *, unsigned char *dst, unsigned char *dst_end, struct lsxpack_header *);
void lshpack_enc_set_max_capacity(struct lshpack_enc *, unsigned);
int lshpack_enc_use_hist(struct lshpack_enc *, int on);
void lshpack_dec_init(struct lshpack_dec *);
void lshpack_dec_cleanup(struct lshpack_dec *);
int lshpack_dec_decode(struct lshpack_dec *, const unsigned char **src, const unsigned char *src_end, struct lsxpack_header *);

static inline void lsxpack_header_prepare_decode(lsxpack_header_t *h, char *out, size_t offset, size_t len) {
    h->buf = out; h->name_offset = (lsxpack_strlen_t)offset; h->val_len = (lsxpack_strlen_t)len; h->name_len = 0;
}
static inline void lsxpack_header_set_offset(lsxpack_header_t *h, const char *buf, size_t name_offset, size_t name_len,
                                             size_t val_offset, size_t val_len) {
    h->buf = (char *)buf; h->name_offset = (lsxpack_strlen_t)name_offset; h->name_len = (lsxpack_strlen_t)name_len;
    h->val_offset = (lsxpack_strlen_t)val_offset; h->val_len = (lsxpack_strlen_t)val_len;
}
static inline void lsxpack_header_set_offset2(lsxpack_header_t *h, const char *buf, size_t name_offset, size_t name_len,
                                              size_t val_offset, size_t val_len) {
    lsxpack_header_set_offset(h, buf, name_offset, name_len, val_offset, val_len);
}
static inline unsigned lsxpack_header_get_dec_size(const lsxpack_header_t *h) {
    return h->name_len + h->val_len + h->dec_overhead;
}

#ifdef __cplusplus
}
#endif
