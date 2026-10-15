/*
 * Paint - draw with the mouse in a mosWM window.
 *
 * Left button paints, right button erases. Pick a colour from the palette,
 * the mouse wheel changes the brush size, C clears the canvas.
 * Presents only the rectangle that changed, like mosWM recommends.
 */
#include "window.h"
#include "stdlib.h"
#include "string.h"
#include "font.h"

#define TOOLBAR 40

static const uint32_t palette[] = {
    0xFF17232A, 0xFFFFFFFF, 0xFFE35D6A, 0xFFE8B34C, 0xFF4ABF8A, 0xFF3DAEE9, 0xFF8E6CEF, 0xFFFF8FB1
};
#define COLORS ((int)(sizeof(palette) / sizeof(palette[0])))

static uint32_t window_id, *pixels, width = 640, height = 420;
static int color = 5, brush = 6, last_x = -1, last_y = -1;
static int dirty_x0, dirty_y0, dirty_x1, dirty_y1, dirty;

static void mark(int x0, int y0, int x1, int y1) {
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > (int)width) x1 = (int)width;
    if (y1 > (int)height) y1 = (int)height;
    if (x0 >= x1 || y0 >= y1) return;
    if (!dirty) { dirty_x0 = x0; dirty_y0 = y0; dirty_x1 = x1; dirty_y1 = y1; dirty = 1; return; }
    if (x0 < dirty_x0) dirty_x0 = x0;
    if (y0 < dirty_y0) dirty_y0 = y0;
    if (x1 > dirty_x1) dirty_x1 = x1;
    if (y1 > dirty_y1) dirty_y1 = y1;
}

static void rect(int x, int y, int w, int h, uint32_t c) {
    for (int py = y; py < y + h; py++)
        for (int px = x; px < x + w; px++)
            if (px >= 0 && py >= 0 && px < (int)width && py < (int)height) pixels[py * width + px] = c;
    mark(x, y, x + w, y + h);
}

static void dot(int cx, int cy, int r, uint32_t c) {
    for (int y = -r; y <= r; y++)
        for (int x = -r; x <= r; x++)
            if (x * x + y * y <= r * r) {
                int px = cx + x, py = cy + y;
                if (px >= 0 && px < (int)width && py >= TOOLBAR && py < (int)height) pixels[py * width + px] = c;
            }
    mark(cx - r, cy - r, cx + r + 1, cy + r + 1);
}

static void stroke(int x0, int y0, int x1, int y1, int r, uint32_t c) {
    int dx = x1 - x0, dy = y1 - y0;
    int steps = (dx < 0 ? -dx : dx) > (dy < 0 ? -dy : dy) ? (dx < 0 ? -dx : dx) : (dy < 0 ? -dy : dy);
    if (steps == 0) { dot(x0, y0, r, c); return; }
    for (int i = 0; i <= steps; i++) dot(x0 + dx * i / steps, y0 + dy * i / steps, r, c);
}

static void toolbar(void) {
    rect(0, 0, (int)width, TOOLBAR, 0xFF24343C);
    for (int i = 0; i < COLORS; i++) {
        int x = 10 + i * 34;
        if (i == color) rect(x - 3, 5, 30, 30, 0xFFFFFFFF);
        rect(x, 8, 24, 24, palette[i]);
    }
    int x = 10 + COLORS * 34 + 12;
    rect(x, 20 - brush / 2, brush, brush, 0xFFFFFFFF);
    draw_text(pixels, width, height, x + 24, 16, "wheel: size  C: clear", 0xFF9BB0BC, 1);
}

static void clear(void) {
    for (uint32_t i = 0; i < width * height; i++) pixels[i] = 0xFFF7F9FA;
    toolbar();
    mark(0, 0, (int)width, (int)height);
}

int main(void) {
    window_id = mos_window_create(0, 100, 70, width, height, "Paint");
    if (!window_id) return 1;
    pixels = malloc((size_t)width * height * 4);
    if (!pixels) return 1;
    clear();
    for (;;) {
        syscall_window_event_t ev;
        while (mos_window_next_event(window_id, &ev) == SYS_SUCCESS) {
            if (ev.type == SYSCALL_WINDOW_EVENT_CLOSE_REQUEST) { mos_window_close(window_id); return 0; }
            if (ev.type == SYSCALL_WINDOW_EVENT_RESIZED) {
                // keep the drawing: copy the overlapping part into the new surface
                uint32_t nw = (uint32_t)ev.width, nh = (uint32_t)ev.height;
                uint32_t* next = malloc((size_t)nw * nh * 4);
                if (!next) continue;
                for (uint32_t i = 0; i < nw * nh; i++) next[i] = 0xFFF7F9FA;
                for (uint32_t y = 0; y < nh && y < height; y++)
                    memcpy(next + y * nw, pixels + y * width, 4 * (nw < width ? nw : width));
                free(pixels);
                pixels = next; width = nw; height = nh;
                toolbar();
                mark(0, 0, (int)width, (int)height);
            }
            if (ev.type == SYSCALL_WINDOW_EVENT_MOUSE_WHEEL) {
                brush += ev.wheel > 0 ? 2 : -2;
                if (brush < 2) brush = 2;
                if (brush > 30) brush = 30;
                toolbar();
            }
            if (ev.type == SYSCALL_WINDOW_EVENT_KEY && ev.buttons && ev.key == 6) clear();   // 6 = HID 'c'
            if (ev.type == SYSCALL_WINDOW_EVENT_MOUSE) {
                int left = ev.buttons & SYSCALL_MOUSE_BTN_LEFT, right = ev.buttons & SYSCALL_MOUSE_BTN_RIGHT;
                if (left && ev.y < TOOLBAR) {
                    int i = (ev.x - 10) / 34;
                    if (ev.x >= 10 && i < COLORS) { color = i; toolbar(); }
                    last_x = -1;
                } else if ((left || right) && ev.y >= TOOLBAR) {
                    uint32_t c = right ? 0xFFF7F9FA : palette[color];
                    if (last_x >= 0) stroke(last_x, last_y, ev.x, ev.y, brush / 2, c);
                    else dot(ev.x, ev.y, brush / 2, c);
                    last_x = ev.x; last_y = ev.y;
                } else last_x = -1;
            }
        }
        if (dirty) {
            mos_window_present(window_id, pixels, width * 4, (uint32_t)dirty_x0, (uint32_t)dirty_y0,
                               (uint32_t)(dirty_x1 - dirty_x0), (uint32_t)(dirty_y1 - dirty_y0));
            dirty = 0;
        }
        mos_sleep(10);
    }
}
