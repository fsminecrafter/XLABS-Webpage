#ifndef _STDARG_H
#define _STDARG_H
/* Every argument occupies one 8-byte slot, so va_list is a cursor into
 * the caller's argument area. */
typedef __builtin_va_list va_list;
#define va_start(ap, last) __builtin_va_start(ap, last)
#define va_arg(ap, type) __builtin_va_arg(ap, type)
#define va_end(ap) __builtin_va_end(ap)
#define va_copy(dst, src) __builtin_va_copy(dst, src)
#endif
