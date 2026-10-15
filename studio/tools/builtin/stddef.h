#ifndef _STDDEF_H
#define _STDDEF_H
typedef unsigned long size_t;
typedef long ptrdiff_t;
typedef long ssize_t;
#ifndef __cplusplus
typedef int wchar_t;
#endif
typedef long max_align_t;
#ifdef __cplusplus
#define NULL nullptr
#else
#define NULL ((void*)0)
#endif
#define offsetof(type, member) __builtin_offsetof(type, member)
#endif
