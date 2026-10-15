#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>

typedef struct { void (*on_close)(int); void (*on_resize)(int, unsigned, unsigned); int (*score)(const char*); } Callbacks;
static int closes; static unsigned area;
static void do_close(int id) { closes += id; }
static void do_resize(int id, unsigned w, unsigned h) { area = w * h + (unsigned)id; }
static int score(const char* s) { int n = 0; while (*s) n += *s++; return n; }
static const Callbacks global_cb = { do_close, do_resize, score };

typedef struct { char name[16]; int hp; float speed; } Entity;
typedef struct { Entity list[4]; int count; } World;

static void apply(const Callbacks* cb) { if (cb->on_close) cb->on_close(7); cb->on_resize(2, 640, 360); }
static double poly(double x) { return ((2.5 * x - 1.0) * x + 0.25) * x; }
static float lerp(float a, float b, float t) { return a + (b - a) * t; }
static int sum2d(int rows, int cols, int m[][3]) { int s = 0; for (int r = 0; r < rows; r++) for (int c = 0; c < cols; c++) s += m[r][c] * (r + 1); return s; }
static long fact(int n) { return n <= 1 ? 1 : n * fact(n - 1); }
static int collatz(long n) { int steps = 0; while (n != 1) { n = (n & 1) ? 3 * n + 1 : n / 2; steps++; } return steps; }
static void rev(char* s) { size_t n = strlen(s); for (size_t i = 0; i < n / 2; i++) { char t = s[i]; s[i] = s[n - 1 - i]; s[n - 1 - i] = t; } }
static uint32_t blend(uint32_t a, uint32_t b, uint8_t t) {
    uint32_t r = (((a >> 16) & 255) * (255 - t) + ((b >> 16) & 255) * t) / 255;
    uint32_t g = (((a >> 8) & 255) * (255 - t) + ((b >> 8) & 255) * t) / 255;
    uint32_t bl = ((a & 255) * (255 - t) + (b & 255) * t) / 255;
    return 0xFF000000u | r << 16 | g << 8 | bl;
}

int main(void) {
    Callbacks cb = global_cb;
    apply(&cb); cb.on_close = NULL; apply(&cb);
    printf("cb %d %u %d\n", closes, area, global_cb.score("abc"));
    World w; memset(&w, 0, sizeof w);
    for (int i = 0; i < 4; i++) { strcpy(w.list[i].name, "unit"); w.list[i].name[4] = (char)('0' + i); w.list[i].hp = 100 - i * 7; w.list[i].speed = 1.5f * i; w.count++; }
    World w2 = w; w2.list[2].hp = 1;
    int hp = 0; for (int i = 0; i < w.count; i++) hp += w.list[i].hp;
    printf("world %d %s %d %d %d\n", hp, w.list[3].name, w2.list[2].hp, w.list[2].hp, (int)(w.list[3].speed * 10));
    printf("poly %ld %ld\n", (long)(poly(1.5) * 1e6), (long)(poly(-3.25) * 1e6));
    printf("lerp %d %d\n", (int)(lerp(10.0f, 20.0f, 0.25f) * 100), (int)(lerp(-1.0f, 1.0f, 0.75f) * 1000));
    int m[2][3] = { { 1, 2, 3 }, { 4, 5, 6 } }; printf("2dpass %d\n", sum2d(2, 3, m));
    printf("fact %ld %ld\n", fact(10), fact(20));
    printf("collatz %d\n", collatz(837799));
    char s[] = "Minimal-OS"; rev(s); printf("rev %s\n", s);
    printf("blend %x %x\n", blend(0xFF102030u, 0xFFF0E0D0u, 128), blend(0xFF000000u, 0xFFFFFFFFu, 255));
    char c = 100; c += 100; unsigned char uc = 250; uc += 10; short sh = 30000; sh *= 2;
    printf("narrowops %d %d %d\n", c, uc, sh);
    float f = 3; f *= 2.5; f /= 4; int fi = 7; fi *= 1.5; printf("fops %d %d\n", (int)(f * 100), fi);
    double d = 10; d -= 0.125; d /= 2; printf("dops %ld\n", (long)(d * 1000));
    int arr[10]; int* p = arr + 9; p -= 4; *p = 42; p[1] = 43; printf("ptrops %d %d %ld\n", arr[5], arr[6], (long)(p - arr));
    long big = 1L << 62; big >>= 3; big |= 5; big ^= 1; printf("longops %ld %ld\n", big, -big % 1000);
    unsigned long ub = 0xFFFFFFFFFFFFFFF0UL; ub >>= 4; ub *= 3; printf("ulops %lu\n", ub);
    bool b1 = 5, b2 = 0; b2 = !b2; printf("bool %d %d %d\n", b1, b2, (int)sizeof(bool));
    const char* strs[] = { "alpha", "beta", NULL };
    int tot = 0; for (const char** q = strs; *q; q++) tot += (int)strlen(*q); printf("strs %d\n", tot);
    int* hp2 = calloc(100, sizeof(int)); for (int i = 0; i < 100; i++) hp2[i] = i; hp2 = realloc(hp2, 200 * sizeof(int)); for (int i = 100; i < 200; i++) hp2[i] = i;
    long acc = 0; for (int i = 0; i < 200; i++) acc += hp2[i]; free(hp2); printf("heap %ld\n", acc);
    int x = 0; for (int i = 0; i < 100; i++) { switch (i % 4) { case 0: x += 1; break; case 1: x += 10; case 2: x += 100; break; default: x -= 3; } } printf("sw %d\n", x);
    unsigned char bytes[256]; for (int i = 0; i < 256; i++) bytes[i] = (unsigned char)(i * 37); uint32_t h = 0; for (int i = 0; i < 256; i++) h = (h << 5) - h + bytes[i]; printf("hash %u\n", h);
    double dd = -0.0; printf("negzero %d %d\n", dd == 0.0, 1.0 / 0.0 > 1e308);
    int neg = -17; printf("negshift %d %d %u\n", neg >> 2, neg / 4, (unsigned)neg >> 28);
    printf("ternptr %s\n", (x > 0 ? "pos" : "neg"));
    printf("sizeof %d %d %d\n", (int)sizeof(Entity), (int)sizeof(World), (int)sizeof(Callbacks));
    int i = 0, j = 10; while (i < j) { i += 2; j -= 1; } printf("while %d %d\n", i, j);
    printf("char %c%c%c\n", "xyz"[2], 'A' + 2, *"Q");
    printf("done\n");
    return 0;
}
