/*
 * Snake - keyboard input in a mosWM window.
 *
 * Window key events carry USB HID usage codes: the arrow keys are
 * 79 (right), 80 (left), 81 (down) and 82 (up); 44 is space.
 * Click the window first so it has keyboard focus.
 */
#include "window.h"
#include "stdlib.h"
#include "string.h"
#include "font.h"

#define CELL 16
#define COLS 30
#define ROWS 20
#define MAX_LEN (COLS * ROWS)

enum { KEY_RIGHT = 79, KEY_LEFT = 80, KEY_DOWN = 81, KEY_UP = 82, KEY_SPACE = 44 };

typedef struct { int x, y; } Cell;

static uint32_t window_id, *pixels;
static const uint32_t W = COLS * CELL, H = ROWS * CELL + 28;
static Cell body[MAX_LEN];
static int length, dir_x, dir_y, next_x, next_y, score, best, dead;
static Cell food;

static void rect(int x, int y, int w, int h, uint32_t c) {
    for (int py = y; py < y + h; py++)
        for (int px = x; px < x + w; px++)
            if (px >= 0 && py >= 0 && px < (int)W && py < (int)H) pixels[py * W + px] = c;
}

static int occupied(int x, int y) {
    for (int i = 0; i < length; i++) if (body[i].x == x && body[i].y == y) return 1;
    return 0;
}

static void place_food(void) {
    do {
        uint64_t r = mos_random_u64();
        food.x = (int)(r % COLS);
        food.y = (int)((r >> 20) % ROWS);
    } while (occupied(food.x, food.y));
}

static void reset(void) {
    length = 4;
    for (int i = 0; i < length; i++) { body[i].x = 8 - i; body[i].y = ROWS / 2; }
    dir_x = next_x = 1; dir_y = next_y = 0;
    score = 0; dead = 0;
    place_food();
}

static void step(void) {
    dir_x = next_x; dir_y = next_y;
    int nx = body[0].x + dir_x, ny = body[0].y + dir_y;
    if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS || occupied(nx, ny)) { dead = 1; if (score > best) best = score; return; }
    int grow = nx == food.x && ny == food.y;
    if (grow && length < MAX_LEN) length++;
    memmove(&body[1], &body[0], sizeof(Cell) * (size_t)(length - 1));
    body[0].x = nx; body[0].y = ny;
    if (grow) { score += 10; place_food(); }
}

static void itoa10(int v, char* out) {
    char t[12]; int n = 0;
    do { t[n++] = (char)('0' + v % 10); v /= 10; } while (v);
    while (n) *out++ = t[--n];
    *out = 0;
}

static void draw(void) {
    rect(0, 0, (int)W, (int)H, 0xFF101B21);
    for (int y = 0; y < ROWS; y++)
        for (int x = 0; x < COLS; x++)
            if ((x + y) & 1) rect(x * CELL, 28 + y * CELL, CELL, CELL, 0xFF13222A);
    rect(food.x * CELL + 3, 28 + food.y * CELL + 3, CELL - 6, CELL - 6, 0xFFE35D6A);
    for (int i = length - 1; i >= 0; i--)
        rect(body[i].x * CELL + 1, 28 + body[i].y * CELL + 1, CELL - 2, CELL - 2, i ? 0xFF4ABF8A : 0xFFB8F2D2);
    char line[64], num[12];
    strcpy(line, "Score "); itoa10(score, num); strcpy(line + strlen(line), num);
    strcpy(line + strlen(line), "   Best "); itoa10(best, num); strcpy(line + strlen(line), num);
    draw_text(pixels, W, H, 8, 8, line, 0xFFEAF2F8, 1);
    if (dead) {
        const char* msg = "Game over - press space";
        draw_text(pixels, W, H, ((int)W - text_width(msg, 2)) / 2, (int)H / 2, msg, 0xFFFFD166, 2);
    }
}

int main(void) {
    window_id = mos_window_create(0, 160, 80, W, H, "Snake");
    if (!window_id) return 1;
    mos_window_set_resizable(window_id, false);
    syscall_window_style_t style = {
        .title_bar = 0xFF101B21, .title_text = 0xFFEAF2F8, .close_button = 0xFFE35D6A,
        .minimize_button = 0xFFE8B34C, .maximize_button = 0xFF4ABF8A, .close_icon = 0xFFFFFFFF,
        .minimize_icon = 0xFF17262C, .maximize_icon = 0xFF17262C, .border = 0xFF2B3E47,
        .content_background = 0xFF101B21
    };
    mos_window_set_style(window_id, style);
    pixels = malloc((size_t)W * H * 4);
    if (!pixels) return 1;
    reset();
    long last = mos_uptime();
    for (;;) {
        syscall_window_event_t ev;
        while (mos_window_next_event(window_id, &ev) == SYS_SUCCESS) {
            if (ev.type == SYSCALL_WINDOW_EVENT_CLOSE_REQUEST) { mos_window_close(window_id); return 0; }
            if (ev.type != SYSCALL_WINDOW_EVENT_KEY || !ev.buttons) continue;   // key presses only
            if (ev.key == KEY_SPACE && dead) reset();
            if (ev.key == KEY_RIGHT && dir_x != -1) { next_x = 1; next_y = 0; }
            if (ev.key == KEY_LEFT && dir_x != 1) { next_x = -1; next_y = 0; }
            if (ev.key == KEY_DOWN && dir_y != -1) { next_x = 0; next_y = 1; }
            if (ev.key == KEY_UP && dir_y != 1) { next_x = 0; next_y = -1; }
        }
        long now = mos_uptime();
        if (!dead && now - last >= 110) { step(); last = now; }
        draw();
        mos_window_present(window_id, pixels, W * 4, 0, 0, W, H);
        mos_sleep(16);
    }
}
