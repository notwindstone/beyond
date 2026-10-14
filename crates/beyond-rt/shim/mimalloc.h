/* Beyond: uSockets (as Bun forked it) allocates with mimalloc; the system
   allocator stands in for it. */
#ifndef BEYOND_MIMALLOC_SHIM_H
#define BEYOND_MIMALLOC_SHIM_H
#include <stdlib.h>
#include <string.h>
#define mi_malloc malloc
#define mi_calloc calloc
#define mi_realloc realloc
#define mi_free free
#define mi_zalloc(n) calloc(1, (n))
#define mi_usable_size(p) 0
/* (Bun returns memory to the system while the loop idles.) */
#define mi_on_thread_idle_start() 0
#define mi_on_thread_idle(...) ((void)0)
#define mi_on_thread_idle_end(...) ((void)0)
#endif
