/*
 * Clock - an analogue clock in a mosWM window.
 *
 * Reads the kernel's real-time clock through SYS_GETTIME and draws the
 * hands with a small sine implementation (the SDK has no libm).
 * Redraws once a second, or when the window is resized.
 */
#include "window.h"
#include "stdlib.h"
#include "string.h"
#include "font.h"

typedef struct {          // datetime_t from the kernel's time.h
    uint16_t year;
    uint8_t month, day, hour, minute, second;
} datetime_t;

#define PI 3.14159265358979

static uint32_t window_id, *pixels, width = 320, height = 360;

static double sine(double x) {
    while (x > PI) x -= 2 * PI;
    while (x < -PI) x += 2 * PI;
    double x2 = x * x, term = x, sum = x;
    for (int n = 1; n < 10; n++) { term *= -x2 / ((2 * n) * (2 * n + 1)); sum += term; }
    return sum;
}
static double cosine(double x) { return sine(x + PI / 2); }

static void plot(int x, int y, uint32_t c) {
    if (x >= 0 && y >= 0 && x < (int)width && y < (int)height) pixels[y * width + x] = c;
}

static void disc(int cx, int cy, int r, uint32_t c) {
    for (int y = -r; y <= r; y++) for (int x = -r; x <= r; x++) if (x * x + y * y <= r * r) plot(cx + x, cy + y, c);
}

static void hand(int cx, int cy, double angle, double len, int thick, uint32_t c) {
    double dx = sine(angle), dy = -cosine(angle);
    for (double t = 0; t <= len; t += 0.5) disc(cx + (int)(dx * t), cy + (int)(dy * t), thick, c);
}

static void two(char* out, int v) { out[0] = (char)('0' + v / 10); out[1] = (char)('0' + v % 10); }

static void draw(const datetime_t* now) {
    for (uint32_t i = 0; i < width * height; i++) pixels[i] = 0xFF17232A;
    int size = (int)(width < height - 40 ? width : height - 40);
    int cx = (int)width / 2, cy = size / 2 + 6, r = size / 2 - 16;
    if (r < 10) return;
    disc(cx, cy, r + 6, 0xFF2B3E47);
    disc(cx, cy, r, 0xFFF3F5F6);
    for (int i = 0; i < 60; i++) {
        double a = i * PI / 30;
        int len = i % 5 ? 4 : 10;
        for (int t = r - len - 4; t < r - 4; t++)
            disc(cx + (int)(sine(a) * t), cy - (int)(cosine(a) * t), i % 5 ? 0 : 1, 0xFF24343C);
    }
    double s = now->second, m = now->minute + s / 60.0, h = (now->hour % 12) + m / 60.0;
    hand(cx, cy, h * PI / 6, r * 0.5, 3, 0xFF24343C);
    hand(cx, cy, m * PI / 30, r * 0.75, 2, 0xFF24343C);
    hand(cx, cy, s * PI / 30, r * 0.85, 0, 0xFFE35D6A);
    disc(cx, cy, 5, 0xFFE35D6A);
    char clock_text[] = "00:00:00", date_text[] = "0000-00-00";
    two(clock_text, now->hour); two(clock_text + 3, now->minute); two(clock_text + 6, now->second);
    two(date_text, now->year / 100); two(date_text + 2, now->year % 100); two(date_text + 5, now->month); two(date_text + 8, now->day);
    draw_text(pixels, width, height, cx - text_width(clock_text, 2) / 2, size, clock_text, 0xFFEAF2F8, 2);
    draw_text(pixels, width, height, cx - text_width(date_text, 1) / 2, size + 22, date_text, 0xFF9BB0BC, 1);
}

int main(void) {
    window_id = mos_window_create(0, 220, 60, width, height, "Clock");
    if (!window_id) return 1;
    pixels = malloc((size_t)width * height * 4);
    if (!pixels) return 1;
    int last_second = -1;
    for (;;) {
        syscall_window_event_t ev;
        while (mos_window_next_event(window_id, &ev) == SYS_SUCCESS) {
            if (ev.type == SYSCALL_WINDOW_EVENT_CLOSE_REQUEST) { mos_window_close(window_id); return 0; }
            if (ev.type == SYSCALL_WINDOW_EVENT_RESIZED) {
                uint32_t* p = realloc(pixels, (size_t)ev.width * ev.height * 4);
                if (!p) return 1;
                pixels = p; width = (uint32_t)ev.width; height = (uint32_t)ev.height;
                last_second = -1;
            }
        }
        datetime_t now;
        mos_syscall(SYS_GETTIME, (long)(uintptr_t)&now, 0, 0);
        if (now.second != last_second) {
            last_second = now.second;
            draw(&now);
            mos_window_present(window_id, pixels, width * 4, 0, 0, width, height);
        }
        mos_sleep(50);
    }
}
