/* Beyond: the assertion macros of WebKit's WTF that Bun's uWebSockets uses. */
#pragma once
#include <stdlib.h>
#ifndef ASSERT
#define ASSERT(...) ((void)0)
#endif
#ifndef ASSERT_NOT_REACHED
#define ASSERT_NOT_REACHED() ((void)0)
#endif
#ifndef RELEASE_ASSERT
#define RELEASE_ASSERT(x) do { if (!(x)) abort(); } while (0)
#endif
#ifndef RELEASE_ASSERT_NOT_REACHED
#define RELEASE_ASSERT_NOT_REACHED() abort()
#endif
