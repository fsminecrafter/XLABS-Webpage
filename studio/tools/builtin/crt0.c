/*
 * The Studio crt0. Same out-of-line memory primitives as the SDK's crt0.c
 * (GCC-style struct copies and user code call them). The entry point
 * _start(argc, argv) -> main -> mos_exit is emitted by the back end.
 */
#include "minimalos.h"
#include "stdlib.h"

void* memcpy(void* dst, const void* src, unsigned long n) {
    unsigned char* d = (unsigned char*)dst;
    const unsigned char* s = (const unsigned char*)src;
    for (unsigned long i = 0; i < n; i++) d[i] = s[i];
    return dst;
}

void* memmove(void* dst, const void* src, unsigned long n) {
    unsigned char* d = (unsigned char*)dst;
    const unsigned char* s = (const unsigned char*)src;
    if (d == s || n == 0) return dst;
    if (d < s) {
        for (unsigned long i = 0; i < n; i++) d[i] = s[i];
    } else {
        for (unsigned long i = n; i > 0; i--) d[i - 1] = s[i - 1];
    }
    return dst;
}

void* memset(void* dst, int value, unsigned long n) {
    unsigned char* d = (unsigned char*)dst;
    for (unsigned long i = 0; i < n; i++) d[i] = (unsigned char)value;
    return dst;
}

int memcmp(const void* a, const void* b, unsigned long n) {
    const unsigned char* x = (const unsigned char*)a;
    const unsigned char* y = (const unsigned char*)b;
    for (unsigned long i = 0; i < n; i++) {
        if (x[i] != y[i]) return (int)x[i] - (int)y[i];
    }
    return 0;
}

/* C++ runtime: operator new/delete and array construction. */

void* __mcc_alloc(unsigned long size) {
    long r = mos_syscall(SYS_HEAP, SYS_HEAP_ALLOC_ZEROED, 0, (long)(size ? size : 1));
    if (mos_heap_failed(r)) return 0;
    return (void*)r;
}

void __mcc_free(void* ptr) {
    if (ptr) mos_syscall(SYS_HEAP, SYS_HEAP_FREE, (long)ptr, 0);
}
void __mcc_array_ctor(void* p, unsigned long n, unsigned long size, void (*ctor)(void*)) {
    char* c = (char*)p;
    for (unsigned long i = 0; i < n; i++) ctor(c + i * size);
}

void __mcc_array_dtor(void* p, unsigned long n, unsigned long size, void (*dtor)(void*)) {
    char* c = (char*)p;
    for (unsigned long i = n; i > 0; i--) dtor(c + (i - 1) * size);
}
