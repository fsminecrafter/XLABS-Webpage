/*
 * Hello window - a mosWM application.
 *
 * Creates a window, draws into its ARGB8888 surface and presents it.
 * Move the mouse over it, click, resize it from the lower-right corner,
 * or drag it to a screen edge to tile it.
 */
#include "window.h"
#include "stdlib.h"
#include "string.h"
#include "stdio.h"
#include "font.h"

static uint32_t window_id;
static uint32_t* pixels;
static uint32_t width = 520;
static uint32_t height = 300;
static int mouse_x = -1, mouse_y = -1, clicks;
static uint32_t last_buttons;
static int focused = 1;

static void fill(int x, int y, int w, int h, uint32_t color) {
    for (int py = y; py < y + h; py++) {
        if (py < 0 || py >= (int)height) continue;
        for (int px = x; px < x + w; px++)
            if (px >= 0 && px < (int)width) pixels[py * width + px] = color;
    }
}

static void draw(uint32_t frame) {
    // vertical gradient from the MOSdesk blue to a deep teal
    for (uint32_t y = 0; y < height; y++) {
        uint32_t t = y * 255 / height;
        uint32_t r = (0x3D * (255 - t) + 0x10 * t) / 255;
        uint32_t g = (0xAE * (255 - t) + 0x2A * t) / 255;
        uint32_t b = (0xE9 * (255 - t) + 0x3A * t) / 255;
        uint32_t color = 0xFF000000u | r << 16 | g << 8 | b;
        for (uint32_t x = 0; x < width; x++) pixels[y * width + x] = color;
    }
    const char* title = "Hello from Minimal-OS!";
    int tw = text_width(title, 3);
    draw_text(pixels, width, height, ((int)width - tw) / 2 + 2, 42, title, 0x60000000u, 3);
    draw_text(pixels, width, height, ((int)width - tw) / 2, 40, title, 0xFFFFFFFFu, 3);

    char line[96];
    char num[24];
    // a tiny integer formatter, since the SDK has printf but no sprintf
    #define APPEND_NUM(value) do { long v_ = (long)(value); int n_ = 0; char t_[24]; \
        if (v_ < 0) { strcpy(num, "-"); v_ = -v_; } else num[0] = 0; \
        do { t_[n_++] = (char)('0' + v_ % 10); v_ /= 10; } while (v_); \
        int k_ = (int)strlen(num); while (n_) num[k_++] = t_[--n_]; num[k_] = 0; \
        strcpy(line + strlen(line), num); } while (0)

    strcpy(line, "Surface ");
    APPEND_NUM(width); strcpy(line + strlen(line), " x "); APPEND_NUM(height);
    strcpy(line + strlen(line), "   frame "); APPEND_NUM(frame);
    draw_text(pixels, width, height, 24, 110, line, 0xFFE6F4FFu, 2);

    strcpy(line, "Mouse ");
    if (mouse_x < 0) strcpy(line + strlen(line), "outside");
    else { APPEND_NUM(mouse_x); strcpy(line + strlen(line), ", "); APPEND_NUM(mouse_y); }
    strcpy(line + strlen(line), "   clicks "); APPEND_NUM(clicks);
    draw_text(pixels, width, height, 24, 140, line, 0xFFE6F4FFu, 2);

    draw_text(pixels, width, height, 24, (int)height - 34,
              focused ? "Focused - try resizing me" : "Click to focus", 0xC0FFFFFFu, 2);

    // a bouncing square so you can see the frames arrive
    int span = (int)width - 60;
    int pos = span > 0 ? (int)(frame * 4 % (uint32_t)(span * 2)) : 0;
    if (pos > span) pos = span * 2 - pos;
    fill(30 + pos, 180, 28, 28, 0xFFFFD166u);
    if (mouse_x >= 0) fill(mouse_x - 3, mouse_y - 3, 7, 7, 0xFFFF5D73u);
}

int main(void) {
    window_id = mos_window_create(0, 120, 90, width, height, "Hello window");
    if (!window_id) { printf("mosWM is not running\n"); return 1; }
    pixels = calloc((size_t)width * height, sizeof(uint32_t));
    if (!pixels) { mos_window_close(window_id); return 1; }
    printf("window %u created\n", window_id);

    for (uint32_t frame = 0;; frame++) {
        syscall_window_event_t event;
        while (mos_window_next_event(window_id, &event) == SYS_SUCCESS) {
            switch (event.type) {
                case SYSCALL_WINDOW_EVENT_CLOSE_REQUEST:
                    printf("closing after %u frames\n", frame);
                    mos_window_close(window_id);
                    free(pixels);
                    return 0;
                case SYSCALL_WINDOW_EVENT_RESIZED: {
                    uint32_t* resized = realloc(pixels, (size_t)event.width * event.height * sizeof(uint32_t));
                    if (!resized) return 1;
                    pixels = resized;
                    width = (uint32_t)event.width;
                    height = (uint32_t)event.height;
                    break;
                }
                case SYSCALL_WINDOW_EVENT_MOUSE:
                    mouse_x = event.x;
                    mouse_y = event.y;
                    if ((event.buttons & 1) && !(last_buttons & 1)) clicks++;
                    last_buttons = event.buttons;
                    break;
                case SYSCALL_WINDOW_EVENT_FOCUS_GAINED: focused = 1; break;
                case SYSCALL_WINDOW_EVENT_FOCUS_LOST: focused = 0; mouse_x = -1; break;
            }
        }
        draw(frame);
        mos_window_present(window_id, pixels, width * sizeof(uint32_t), 0, 0, width, height);
        mos_sleep(16);
    }
}
