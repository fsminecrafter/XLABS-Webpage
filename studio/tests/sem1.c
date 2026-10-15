#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdarg.h>
#include <stddef.h>

typedef struct { int x, y; } Point;
typedef struct Node { int value; struct Node* next; } Node;
struct Big { char tag; long n; short s[3]; double d; Point p; };
union U { uint32_t u; uint8_t b[4]; float f; };
enum Color { RED, GREEN = 5, BLUE };

static int counter(void) { static int n = 10; return n++; }
static Point mkpoint(int x, int y) { Point p = { x, y }; return p; }
static int dist2(Point a, Point b) { int dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }
static struct Big bigret(int k) { struct Big b = { 'q', 100000000000L * k, { 1, 2, 3 }, 2.5, { k, -k } }; return b; }
static int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
static int add(int a, int b) { return a + b; }
static int mul(int a, int b) { return a * b; }
static int (*ops[])(int, int) = { add, mul };
static const char* names[] = { "zero", "one", "two" };
static int table[3][4] = { { 1, 2, 3, 4 }, { 5, 6 }, [2] = { [3] = 9 } };
static Point pts[] = { { 1, 2 }, { .y = 7, .x = 3 } };
static char greeting[] = "hey";
static const char* gp = greeting + 1;

static long sum(int n, ...) {
    va_list ap; va_start(ap, n);
    long s = 0;
    for (int i = 0; i < n; i++) s += va_arg(ap, long);
    va_end(ap);
    return s;
}
static int mixed(const char* fmt, ...) {
    va_list ap; va_start(ap, fmt);
    long acc = 0;
    for (const char* p = fmt; *p; p++) {
        if (*p == 'i') acc += va_arg(ap, int);
        else if (*p == 'd') acc += (long)(va_arg(ap, double) * 100);
        else if (*p == 's') acc += (long)strlen(va_arg(ap, char*));
        else if (*p == 'l') acc += va_arg(ap, long) / 1000;
    }
    va_end(ap);
    return (int)acc;
}

static void sort(int* a, int n) {
    for (int i = 1; i < n; i++) { int v = a[i], j = i - 1; while (j >= 0 && a[j] > v) { a[j + 1] = a[j]; j--; } a[j + 1] = v; }
}
static uint64_t fnv(const char* s) {
    uint64_t h = 14695981039346656037UL;
    while (*s) { h ^= (unsigned char)*s++; h *= 1099511628211UL; }
    return h;
}
static uint32_t xorshift(uint32_t x) { x ^= x << 13; x ^= x >> 17; x ^= x << 5; return x; }

int main(void) {
    // integers
    int a = 2147483647; a += 1; printf("wrap %d\n", a);
    unsigned u = 0; u -= 1; printf("uwrap %u\n", u);
    printf("div %d %d %d %d\n", -7 / 2, -7 % 2, 7 / -2, 7 % -2);
    printf("udiv %u %u\n", 4000000000u / 3u, 4000000000u % 7u);
    printf("mix %d %u\n", -1 < 1u, (unsigned)-1 > 5);
    printf("shift %d %d %u %d\n", 1 << 30, -16 >> 2, 0x80000000u >> 31, (int)(0xF0u << 24) >> 28);
    char c = (char)200; unsigned char uc = 200; short sh = (short)40000;
    printf("narrow %d %d %d %d\n", c, uc, sh, (unsigned short)-1);
    long l = 1L << 40; printf("long %ld %ld\n", l, l * 3 - 1);
    long long ll = -9223372036854775807LL - 1; printf("llmin %ld\n", ll);
    unsigned long ul = 18446744073709551615UL; printf("ulmax %lu %lu\n", ul, ul / 10);
    printf("lmix %ld %lu\n", (long)-5 / 2, (unsigned long)(-5L) % 1000);
    int x = 5; int y = x++; y += ++x; printf("incs %d %d\n", x, y);
    printf("cond %d %d\n", x > 3 ? 10 : 20, x < 3 ? 10 : 20);
    printf("logic %d %d %d %d\n", 3 && 0, 3 || 0, !5, !0);
    printf("bits %x %x %x %x\n", 0xF0F0 & 0xFF00, 0xF0F0 | 0x0F, 0xFF ^ 0x0F, ~0u);
    int arr[8] = { 5, 3, 9, 1, 7, 2, 8, 6 }; sort(arr, 8);
    for (int i = 0; i < 8; i++) printf("%d%c", arr[i], i == 7 ? '\n' : ',');
    printf("fib %d\n", fib(20));
    { int c1 = counter(); int c2 = counter(); int c3 = counter(); printf("counter %d %d %d\n", c1, c2, c3); }
    // pointers
    int* p = arr + 3; printf("ptr %d %d %ld\n", *p, p[-1], (long)(p - arr));
    int* q = &arr[7]; printf("ptrcmp %d %d\n", p < q, q - p);
    char buf[32]; strcpy(buf, "hello"); buf[0] = 'j'; printf("str %s %d %d\n", buf, (int)strlen(buf), strcmp("abc", "abd"));
    printf("strstr %s\n", strstr("minimal-os sdk", "os"));
    // structs
    Point pa = mkpoint(1, 2), pb = { 4, 6 };
    printf("dist %d\n", dist2(pa, pb));
    struct Big b = bigret(3); struct Big b2 = b; b2.p.x = 99;
    printf("big %c %ld %d %d %d %d %d\n", b.tag, b.n, b.s[2], (int)(b.d * 10), b.p.y, b2.p.x, b.p.x);
    printf("sizes %d %d %d %d %d\n", (int)sizeof(struct Big), (int)sizeof(Point), (int)offsetof(struct Big, d), (int)sizeof(union U), (int)sizeof(Node));
    union U un; un.u = 0x11223344; printf("union %x %x\n", un.b[0], un.b[3]);
    un.f = 1.0f; printf("float bits %x\n", un.u);
    enum Color col = BLUE; printf("enum %d %d\n", col, GREEN);
    // globals
    printf("tables %d %d %d %d\n", table[0][3], table[1][1], table[1][2], table[2][3]);
    printf("pts %d %d %d %d\n", pts[0].x, pts[1].x, pts[1].y, (int)(sizeof pts / sizeof pts[0]));
    printf("names %s %s gp %s\n", names[1], names[2], gp);
    printf("fptr %d %d\n", ops[0](6, 7), ops[1](6, 7));
    int (*fp)(int, int) = mul; printf("fp2 %d\n", (*fp)(3, 4));
    // varargs
    printf("sum %ld\n", sum(4, 1L, 2L, 3L, 40000000000L));
    printf("mixed %d\n", mixed("idsl", 7, 1.25, "four", 5000L));
    // linked list
    Node* head = NULL;
    for (int i = 0; i < 5; i++) { Node* n = malloc(sizeof(Node)); n->value = i * i; n->next = head; head = n; }
    int total = 0; for (Node* n = head; n; n = n->next) total += n->value;
    printf("list %d\n", total);
    while (head) { Node* n = head->next; free(head); head = n; }
    // switch
    for (int i = 0; i < 6; i++) {
        switch (i) {
            case 0: printf("zero "); break;
            case 1: case 2: printf("small "); /* fallthrough */
            case 3: printf("three "); break;
            default: printf("big ");
        }
    }
    printf("\n");
    long sw = 5000000000L;
    switch (sw) { case 5000000000L: printf("bigcase\n"); break; default: printf("nocase\n"); }
    // loops
    int k = 0; do { k += 3; } while (k < 10); printf("do %d\n", k);
    int s2 = 0; for (int i = 0; i < 10; i++) { if (i % 2) continue; if (i > 6) break; s2 += i; } printf("for %d\n", s2);
    // floats
    double d = 3.0 / 7.0; float f = (float)d;
    printf("fl %ld %ld %d %d\n", (long)(d * 1e9), (long)(f * 1e9), (int)-2.7, (int)2.7);
    printf("fl2 %d %d %d\n", (int)(0.1 + 0.2 == 0.3), (int)(1e300 * 10 > 1e308), (int)((float)16777217 == 16777216.0f));
    double acc = 0; for (int i = 1; i <= 100; i++) acc += 1.0 / i; printf("harm %ld\n", (long)(acc * 1000000));
    unsigned long big = (unsigned long)1e19; printf("f2ul %lu\n", big);
    printf("i2f %d\n", (int)(float)123456789);
    // hashing
    printf("fnv %lu\n", fnv("Minimal-OS"));
    uint32_t r = 1; for (int i = 0; i < 1000; i++) r = xorshift(r); printf("xs %u\n", r);
    // compound literal & misc
    Point* cp = &(Point){ 8, 9 }; printf("cl %d %d\n", cp->x, cp->y);
    int comma = (1, 2, 3); printf("comma %d\n", comma);
    char str2[] = { 'a', 'b', 0 }; printf("arr %s %d\n", str2, (int)sizeof str2);
    int m[2][3]; for (int i = 0; i < 2; i++) for (int j = 0; j < 3; j++) m[i][j] = i * 10 + j;
    int* flat = &m[0][0]; printf("2d %d %d\n", flat[4], *(*(m + 1) + 2));
    uint8_t bytes[4] = { 0x78, 0x56, 0x34, 0x12 }; uint32_t w; memcpy(&w, bytes, 4); printf("memcpy %x\n", w);
    memset(bytes, 0xAB, 2); printf("memset %x %x\n", bytes[1], bytes[2]);
    printf("char arith %d %d\n", 'a' + 1, (char)('z' + 10));
    unsigned short us = 65535; us++; printf("us %d\n", us);
    int neg = -5; unsigned int un2 = neg; printf("conv %u %ld %lu\n", un2, (long)neg, (unsigned long)neg);
    long lv = -1; unsigned int ui = 1; printf("lcmp %d\n", lv < ui);
    printf("done\n");
    return 0;
}
