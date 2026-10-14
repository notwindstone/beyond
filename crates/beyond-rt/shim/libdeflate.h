/* Beyond: the part of libdeflate (raw DEFLATE in one call) that Bun's
   uWebSockets uses for permessage-deflate, on zlib. */
#pragma once
#include <stdlib.h>
#include <zlib.h>

#ifdef __cplusplus
extern "C" {
#endif

struct libdeflate_compressor { int level; };
struct libdeflate_decompressor { int unused; };

enum libdeflate_result {
    LIBDEFLATE_SUCCESS = 0,
    LIBDEFLATE_BAD_DATA = 1,
    LIBDEFLATE_SHORT_OUTPUT = 2,
    LIBDEFLATE_INSUFFICIENT_SPACE = 3,
};

static inline struct libdeflate_compressor *libdeflate_alloc_compressor(int level) {
    struct libdeflate_compressor *c = (struct libdeflate_compressor *)malloc(sizeof *c);
    if (c) c->level = level;
    return c;
}

static inline struct libdeflate_decompressor *libdeflate_alloc_decompressor(void) {
    return (struct libdeflate_decompressor *)calloc(1, sizeof(struct libdeflate_decompressor));
}

static inline void libdeflate_free_compressor(struct libdeflate_compressor *c) { free(c); }
static inline void libdeflate_free_decompressor(struct libdeflate_decompressor *d) { free(d); }

/* The compressed size, or 0 when it does not fit in `out_nbytes_avail`. */
static inline size_t libdeflate_deflate_compress(struct libdeflate_compressor *c, const void *in, size_t in_nbytes,
                                                 void *out, size_t out_nbytes_avail) {
    z_stream s = {0};
    if (deflateInit2(&s, c->level, Z_DEFLATED, -15, 8, Z_DEFAULT_STRATEGY) != Z_OK) return 0;
    s.next_in = (Bytef *)in;
    s.avail_in = (uInt)in_nbytes;
    s.next_out = (Bytef *)out;
    s.avail_out = (uInt)out_nbytes_avail;
    int r = deflate(&s, Z_FINISH);
    size_t n = r == Z_STREAM_END ? s.total_out : 0;
    deflateEnd(&s);
    return n;
}

static inline enum libdeflate_result libdeflate_deflate_decompress(struct libdeflate_decompressor *d, const void *in,
                                                                   size_t in_nbytes, void *out, size_t out_nbytes_avail,
                                                                   size_t *actual_out_nbytes_ret) {
    (void)d;
    z_stream s = {0};
    if (inflateInit2(&s, -15) != Z_OK) return LIBDEFLATE_BAD_DATA;
    s.next_in = (Bytef *)in;
    s.avail_in = (uInt)in_nbytes;
    s.next_out = (Bytef *)out;
    s.avail_out = (uInt)out_nbytes_avail;
    int r = inflate(&s, Z_FINISH);
    enum libdeflate_result res = r == Z_STREAM_END ? LIBDEFLATE_SUCCESS
                                 : (r == Z_BUF_ERROR && s.avail_out == 0) ? LIBDEFLATE_INSUFFICIENT_SPACE
                                 : LIBDEFLATE_BAD_DATA;
    if (actual_out_nbytes_ret) *actual_out_nbytes_ret = s.total_out;
    inflateEnd(&s);
    return res;
}

#ifdef __cplusplus
}
#endif
