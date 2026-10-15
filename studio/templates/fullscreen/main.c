/*
 * Fullscreen graphics - the graphics.h API.
 *
 * These calls draw straight to the framebuffer (the SYS_GRAPHICS syscall
 * family), the way programs drew before mosWM existed. The demo animates
 * for ten seconds and then exits.
 */
#include "graphics.h"

int main(void) {
    uint32_t w = graphics_get_width();
    uint32_t h = graphics_get_height();
    uint64_t start = mos_uptime();
    for (uint32_t frame = 0; mos_uptime() - start < 10000; frame++) {
        graphics_clear(16, 26, 32);
        for (uint32_t i = 0; i < 12; i++) {
            int32_t x = (int32_t)((frame * (i + 2) * 3 + i * 97) % (w + 200)) - 100;
            int32_t y = (int32_t)(h / 2 + (i % 2 ? 1 : -1) * (int32_t)(i * 22));
            graphics_fill_circle(x, y, 18 + i * 2, (uint8_t)(60 + i * 15), (uint8_t)(174 - i * 6), 233);
        }
        graphics_fill_rectangle(40, 40, 360, 70, 36, 52, 60);
        graphics_rectangle(40, 40, 360, 70, 61, 174, 233);
        graphics_text("Minimal-OS framebuffer graphics", 56, 58, 255, 255, 255);
        graphics_text("graphics_fill_circle / graphics_text / ...", 56, 82, 155, 175, 188);
        graphics_fill_triangle((int32_t)w - 160, (int32_t)h - 60, (int32_t)w - 60, (int32_t)h - 60,
                               (int32_t)w - 110, (int32_t)h - 150, 232, 179, 76);
        graphics_line(0, (int32_t)h - 20, (int32_t)w, (int32_t)h - 20, 74, 191, 138);
        graphics_present(0, 0, (int32_t)w, (int32_t)h);
        mos_sleep(33);
    }
    mos_exit();
}
