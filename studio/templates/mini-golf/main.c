#include "window.h"
#include "minimalos.h"
#include "stdlib.h"
#include "string.h"
#include "font.h"

#define WIDTH 900
#define HEIGHT 640
#define FIELD_X 24
#define FIELD_Y 110
#define FIELD_W 852
#define FIELD_H 478
#define BALL_RADIUS 7
#define HOLE_RADIUS 12
#define MAX_TRAIL 96

enum { ZONE_SAND, ZONE_ROUGH, ZONE_WATER, ZONE_SLOPE };
enum { OBSTACLE_BLOCK, OBSTACLE_BUMPER, OBSTACLE_GATE };
enum { KEY_SPACE = 44, KEY_T = 23, KEY_R = 21, KEY_N = 17,
       KEY_LEFT = 80, KEY_RIGHT = 79, KEY_UP = 82, KEY_DOWN = 81 };

typedef struct {
    int type, x, y, w, h, slope_x, slope_y;
} Zone;

typedef struct {
    int type, x, y, w, h, radius, travel, phase;
} Obstacle;

typedef struct {
    const char* name;
    const char* note;
    int tee_x, tee_y, hole_x, hole_y, par;
    const Zone* zones;
    int zone_count;
    const Obstacle* obstacles;
    int obstacle_count;
    int portal_ax, portal_ay, portal_bx, portal_by, portal_radius;
} Course;

static const Zone zones_first[] = {
    {ZONE_ROUGH, 280, 270, 150, 112, 0, 0}
};
static const Obstacle obstacles_first[] = {
    {OBSTACLE_BUMPER, 420, 220, 0, 0, 25, 0, 0},
    {OBSTACLE_BUMPER, 590, 412, 0, 0, 25, 0, 0}
};

static const Zone zones_sand[] = {
    {ZONE_SAND, 250, 274, 170, 120, 0, 0},
    {ZONE_SAND, 540, 385, 138, 102, 0, 0}
};
static const Obstacle obstacles_sand[] = {
    {OBSTACLE_BLOCK, 465, 186, 22, 234, 0, 0, 0},
    {OBSTACLE_BLOCK, 465, 468, 180, 22, 0, 0, 0},
    {OBSTACLE_BUMPER, 690, 270, 0, 0, 29, 0, 0}
};

static const Zone zones_bank[] = {
    {ZONE_ROUGH, 220, 145, 116, 390, 0, 0},
    {ZONE_SLOPE, 518, 145, 112, 390, 24, 0}
};
static const Obstacle obstacles_bank[] = {
    {OBSTACLE_BLOCK, 382, 154, 23, 252, 0, 0, 0},
    {OBSTACLE_BLOCK, 475, 360, 23, 219, 0, 0, 0},
    {OBSTACLE_BUMPER, 688, 236, 0, 0, 32, 0, 0},
    {OBSTACLE_BUMPER, 693, 446, 0, 0, 28, 0, 0}
};

static const Zone zones_water[] = {
    {ZONE_WATER, 344, 256, 210, 194, 0, 0},
    {ZONE_SAND, 602, 160, 98, 128, 0, 0},
    {ZONE_SAND, 602, 417, 98, 128, 0, 0}
};
static const Obstacle obstacles_water[] = {
    {OBSTACLE_BLOCK, 305, 148, 20, 153, 0, 0, 0},
    {OBSTACLE_BLOCK, 305, 402, 20, 167, 0, 0, 0},
    {OBSTACLE_BLOCK, 562, 148, 19, 146, 0, 0, 0},
    {OBSTACLE_BLOCK, 562, 408, 19, 161, 0, 0, 0},
    {OBSTACLE_BUMPER, 715, 350, 0, 0, 30, 0, 0}
};

static const Zone zones_clockwork[] = {
    {ZONE_SLOPE, 184, 168, 176, 334, 14, -9},
    {ZONE_ROUGH, 420, 140, 122, 388, 0, 0},
    {ZONE_SAND, 665, 395, 110, 116, 0, 0}
};
static const Obstacle obstacles_clockwork[] = {
    {OBSTACLE_BLOCK, 390, 145, 20, 196, 0, 0, 0},
    {OBSTACLE_BLOCK, 390, 398, 20, 177, 0, 0, 0},
    {OBSTACLE_GATE, 546, 311, 18, 132, 0, 156, 310},
    {OBSTACLE_BUMPER, 720, 226, 0, 0, 30, 0, 0}
};

static const Course courses[] = {
    {"First Green", "A clean line and a gentle first putt.",
     105, 349, 806, 349, 3, zones_first, 1, obstacles_first, 2,
     0, 0, 0, 0, 0},
    {"Sandbar", "Sand takes speed away. Bank around the divider.",
     105, 349, 807, 349, 4, zones_sand, 2, obstacles_sand, 3,
     0, 0, 0, 0, 0},
    {"Bank Shot", "Use the rails, then ride the right-hand slope.",
     105, 522, 806, 151, 5, zones_bank, 2, obstacles_bank, 4,
     0, 0, 0, 0, 0},
    {"Waterline", "The pond is a penalty. Find the narrow crossing.",
     105, 349, 807, 349, 4, zones_water, 3, obstacles_water, 5,
     0, 0, 0, 0, 0},
    {"Clockwork", "Catch the moving gate and take the portal shortcut.",
     105, 349, 806, 349, 5, zones_clockwork, 3, obstacles_clockwork, 4,
     280, 350, 670, 350, 23}
};

#define COURSE_COUNT ((int)(sizeof(courses) / sizeof(courses[0])))

static const uint32_t C_BG = 0xFF12211D;
static const uint32_t C_PANEL = 0xFF1B3029;
static const uint32_t C_PANEL_HI = 0xFF284238;
static const uint32_t C_FIELD = 0xFF56845D;
static const uint32_t C_FIELD_LIGHT = 0xFF5D8D64;
static const uint32_t C_INK = 0xFFF4F1E7;
static const uint32_t C_MUTED = 0xFFB6C8B8;
static const uint32_t C_MINT = 0xFFB9E5C8;
static const uint32_t C_GOLD = 0xFFF1C56B;
static const uint32_t C_CORAL = 0xFFE78370;
static const uint32_t C_WATER = 0xFF357F89;
static const uint32_t C_SAND = 0xFFC9A96C;
static const uint32_t C_WALL = 0xFF263A34;

static uint32_t window_id;
static uint32_t* pixels;
static int current_course;
static int strokes[COURSE_COUNT];
static int holed[COURSE_COUNT];
static int scorecard_open;
static int ball_moving;
static int dragging;
static int mouse_down;
static int mouse_x, mouse_y;
static int aim_index;
static int keyboard_power = 62;
static int portal_cooldown;
static float ball_x, ball_y, ball_vx, ball_vy;
static int trail_x[MAX_TRAIL], trail_y[MAX_TRAIL];
static int trail_count, trail_tick;

static const int aim_dx[8] = {1, 1, 0, -1, -1, -1, 0, 1};
static const int aim_dy[8] = {0, -1, -1, -1, 0, 1, 1, 1};

static void rect(int x, int y, int w, int h, uint32_t color) {
    if (w <= 0 || h <= 0) return;
    int x0 = x < 0 ? 0 : x;
    int y0 = y < 0 ? 0 : y;
    int x1 = x + w > WIDTH ? WIDTH : x + w;
    int y1 = y + h > HEIGHT ? HEIGHT : y + h;
    for (int py = y0; py < y1; py++)
        for (int px = x0; px < x1; px++)
            pixels[(size_t)py * WIDTH + px] = color;
}

static void circle(int cx, int cy, int radius, uint32_t fill,
                   uint32_t edge) {
    int outer = radius * radius;
    int inner_radius = radius > 3 ? radius - 3 : 0;
    int inner = inner_radius * inner_radius;
    for (int y = -radius; y <= radius; y++) {
        for (int x = -radius; x <= radius; x++) {
            int d = x * x + y * y;
            int px = cx + x, py = cy + y;
            if (d > outer || px < 0 || py < 0 || px >= WIDTH || py >= HEIGHT)
                continue;
            pixels[(size_t)py * WIDTH + px] = d >= inner ? edge : fill;
        }
    }
}

static void line(int x0, int y0, int x1, int y1, uint32_t color) {
    int dx = x1 >= x0 ? x1 - x0 : x0 - x1;
    int sx = x0 < x1 ? 1 : -1;
    int dy = y1 >= y0 ? y0 - y1 : y1 - y0;
    int sy = y0 < y1 ? 1 : -1;
    int error = dx + dy;
    for (;;) {
        if (x0 >= 0 && y0 >= 0 && x0 < WIDTH && y0 < HEIGHT)
            pixels[(size_t)y0 * WIDTH + x0] = color;
        if (x0 == x1 && y0 == y1) break;
        int twice = error * 2;
        if (twice >= dy) { error += dy; x0 += sx; }
        if (twice <= dx) { error += dx; y0 += sy; }
    }
}

static void text(int x, int y, const char* value, uint32_t color,
                 uint32_t scale) {
    draw_text(pixels, WIDTH, HEIGHT, x, y, value, color, (int)scale);
}

static void centered_text(int x, int y, int width, const char* value,
                          uint32_t color, uint32_t scale) {
    int measured_width = text_width(value, (int)scale);
    text(x + (width - measured_width) / 2, y, value, color, scale);
}

static void number_text(int x, int y, int value, uint32_t color,
                        uint32_t scale) {
    char digits[16];
    char reverse[16];
    int count = 0;
    int negative = value < 0;
    unsigned int magnitude = negative ? 0u - (unsigned int)value :
                                        (unsigned int)value;
    do {
        reverse[count++] = (char)('0' + magnitude % 10);
        magnitude /= 10;
    } while (magnitude && count < 14);
    int out = 0;
    if (negative) digits[out++] = '-';
    for (int i = 0; i < count; i++) digits[out++] = reverse[count - i - 1];
    digits[out] = '\0';
    text(x, y, digits, color, scale);
}

static float square_root(float value) {
    if (value <= 0.0f) return 0.0f;
    float estimate = value > 1.0f ? value : 1.0f;
    for (int i = 0; i < 9; i++) estimate = 0.5f * (estimate + value / estimate);
    return estimate;
}

static int inside_rect(float x, float y, int rx, int ry, int rw, int rh) {
    return x >= rx && y >= ry && x < rx + rw && y < ry + rh;
}

static void clear_trail(void) {
    trail_count = 0;
    trail_tick = 0;
}

static void set_ball_to_tee(void) {
    const Course* course = &courses[current_course];
    ball_x = (float)course->tee_x;
    ball_y = (float)course->tee_y;
    ball_vx = ball_vy = 0.0f;
    ball_moving = 0;
    dragging = 0;
    portal_cooldown = 0;
    clear_trail();
}

static void select_course(int index) {
    if (index < 0 || index >= COURSE_COUNT) return;
    current_course = index;
    scorecard_open = 0;
    aim_index = 0;
    set_ball_to_tee();
}

static void restart_course(void) {
    strokes[current_course] = 0;
    holed[current_course] = 0;
    keyboard_power = 62;
    set_ball_to_tee();
}

static int object_x(const Obstacle* obstacle, long now) {
    if (obstacle->type != OBSTACLE_GATE || obstacle->travel <= 0)
        return obstacle->x;
    int period = obstacle->travel * 2;
    int phase = (int)((now / 10 + obstacle->phase) % period);
    int offset = phase <= obstacle->travel ? phase : period - phase;
    return obstacle->x + offset;
}

static void draw_zone(const Zone* zone, int index) {
    if (zone->type == ZONE_WATER) {
        rect(zone->x, zone->y, zone->w, zone->h, C_WATER);
        for (int y = zone->y + 14; y < zone->y + zone->h; y += 25) {
            int shift = ((y / 25) & 1) ? 12 : 0;
            for (int x = zone->x + 8 + shift; x + 22 < zone->x + zone->w; x += 54)
                line(x, y, x + 21, y, 0xFF68A7A7);
        }
    } else if (zone->type == ZONE_SAND) {
        rect(zone->x, zone->y, zone->w, zone->h, C_SAND);
        for (int y = zone->y + 9; y < zone->y + zone->h; y += 15)
            for (int x = zone->x + 10 + ((y / 15) & 1) * 7;
                 x < zone->x + zone->w; x += 18)
                rect(x, y, 2, 2, 0xFFE0C48A);
    } else if (zone->type == ZONE_ROUGH) {
        rect(zone->x, zone->y, zone->w, zone->h, 0xFF477451);
        for (int x = zone->x + 8; x < zone->x + zone->w; x += 13)
            line(x, zone->y + 5, x - 4, zone->y + zone->h - 5,
                 0xFF56835A);
    } else {
        rect(zone->x, zone->y, zone->w, zone->h, 0xFF629267);
        for (int x = zone->x + 35; x < zone->x + zone->w; x += 82) {
            line(x, zone->y + 24, x + zone->slope_x, zone->y + 24 + zone->slope_y,
                 0xFFB7D09A);
            line(x + zone->slope_x, zone->y + 24 + zone->slope_y,
                 x + zone->slope_x + 9, zone->y + 20 + zone->slope_y,
                 0xFFB7D09A);
        }
    }
    (void)index;
}

static void draw_obstacle(const Obstacle* obstacle, long now) {
    int x = object_x(obstacle, now);
    if (obstacle->type == OBSTACLE_BUMPER) {
        circle(obstacle->x, obstacle->y, obstacle->radius, 0xFF496A50, C_GOLD);
        circle(obstacle->x, obstacle->y, 5, C_GOLD, C_GOLD);
    } else if (obstacle->type == OBSTACLE_GATE) {
        rect(x, obstacle->y, obstacle->w, obstacle->h, 0xFFDC9868);
        rect(x + 5, obstacle->y + 8, obstacle->w - 10, obstacle->h - 16,
             0xFF39473A);
        for (int y = obstacle->y + 14; y < obstacle->y + obstacle->h - 8; y += 20)
            line(x + 2, y, x + obstacle->w - 3, y + 8, 0xFFEAC18B);
    } else {
        rect(x + 3, obstacle->y + 5, obstacle->w, obstacle->h, 0x55303A31);
        rect(x, obstacle->y, obstacle->w, obstacle->h, C_WALL);
        if (obstacle->w > obstacle->h)
            rect(x + 4, obstacle->y + 4, obstacle->w - 8, 3, 0xFF50685B);
        else
            rect(x + 4, obstacle->y + 4, obstacle->w - 8, obstacle->h - 8,
                 0xFF31483C);
    }
}

static void draw_button(int x, int y, int w, int h, const char* label,
                        int selected, int active) {
    uint32_t bg = selected ? 0xFFB9E5C8 : (active ? 0xFF344F42 : C_PANEL_HI);
    uint32_t fg = selected ? C_BG : C_INK;
    rect(x, y, w, h, bg);
    rect(x, y + h - 2, w, 2, selected ? C_GOLD : 0xFF3A5747);
    centered_text(x, y + (h - 16) / 2, w, label, fg, 1);
}

static void draw_header(void) {
    rect(0, 0, WIDTH, HEIGHT, C_BG);
    rect(0, 0, WIDTH, 72, C_PANEL);
    rect(0, 70, WIDTH, 2, 0xFF3C5848);
    text(24, 12, "GREENLINE", C_MINT, 2);
    text(26, 42, "MINI GOLF CLUB", C_MUTED, 1);
    for (int i = 0; i < COURSE_COUNT; i++) {
        char label[3] = {(char)('0' + i + 1), '\0', '\0'};
        draw_button(330 + i * 54, 20, 42, 36, label, i == current_course, 0);
    }
    draw_button(624, 20, 88, 36, "REPLAY", 0, 0);
    draw_button(722, 20, 126, 36, "SCORECARD", scorecard_open, 0);

    const Course* course = &courses[current_course];
    text(FIELD_X, 82, course->name, C_INK, 2);
    text(235, 88, course->note, C_MUTED, 1);

    char parline[20] = "PAR ";
    int par = course->par;
    parline[4] = (char)('0' + par);
    parline[5] = '\0';
    text(720, 87, parline, C_GOLD, 1);
    text(795, 87, "STROKES", C_MUTED, 1);
    number_text(858, 87, strokes[current_course], C_INK, 1);
}

static void draw_course(long now) {
    rect(FIELD_X - 5, FIELD_Y - 5, FIELD_W + 10, FIELD_H + 10, 0xFF21372D);
    rect(FIELD_X, FIELD_Y, FIELD_W, FIELD_H, C_FIELD);
    for (int y = FIELD_Y; y < FIELD_Y + FIELD_H; y += 52) {
        if (((y - FIELD_Y) / 52) & 1)
            rect(FIELD_X, y, FIELD_W, 26, C_FIELD_LIGHT);
    }
    const Course* course = &courses[current_course];
    for (int i = 0; i < course->zone_count; i++)
        draw_zone(&course->zones[i], i);

    if (course->portal_radius) {
        circle(course->portal_ax, course->portal_ay, course->portal_radius,
               0xFF354F72, 0xFF9BC7ED);
        circle(course->portal_bx, course->portal_by, course->portal_radius,
               0xFF354F72, 0xFF9BC7ED);
        circle(course->portal_ax, course->portal_ay, 7, 0xFF9BC7ED, 0xFF9BC7ED);
        circle(course->portal_bx, course->portal_by, 7, 0xFF9BC7ED, 0xFF9BC7ED);
    }
    for (int i = 0; i < course->obstacle_count; i++)
        draw_obstacle(&course->obstacles[i], now);

    circle(course->hole_x, course->hole_y, HOLE_RADIUS + 5, 0xFF6D8D5A,
           0xFFB5CC91);
    circle(course->hole_x, course->hole_y, HOLE_RADIUS, 0xFF101B18,
           0xFF0C1512);
    line(course->hole_x + 4, course->hole_y - 2, course->hole_x + 4,
         course->hole_y - 48, 0xFFEDE8D8);
    line(course->hole_x + 5, course->hole_y - 47, course->hole_x + 34,
         course->hole_y - 39, C_CORAL);
    line(course->hole_x + 34, course->hole_y - 39, course->hole_x + 5,
         course->hole_y - 31, C_CORAL);

    circle(course->tee_x, course->tee_y, 17, 0x335B9368, 0xFFA8D19A);
    text(course->tee_x - 14, course->tee_y + 19, "TEE", C_INK, 1);
    for (int i = 0; i < trail_count; i++) {
        int radius = 1 + i * 2 / (trail_count ? trail_count : 1);
        circle(trail_x[i], trail_y[i], radius, 0xFFE7D696, 0xFFE7D696);
    }

    circle((int)ball_x + 3, (int)ball_y + 4, BALL_RADIUS, 0x55404A3F,
           0x55404A3F);
    circle((int)ball_x, (int)ball_y, BALL_RADIUS, 0xFFF8F4E9, 0xFFCFD8C9);
    circle((int)ball_x - 2, (int)ball_y - 2, 2, 0xFFFFFFFF, 0xFFFFFFFF);

    if (dragging && !ball_moving) {
        int dx = (int)ball_x - mouse_x;
        int dy = (int)ball_y - mouse_y;
        float length = square_root((float)(dx * dx + dy * dy));
        if (length > 4.0f) {
            float scale = 84.0f / length;
            int end_x = (int)ball_x + (int)(dx * scale);
            int end_y = (int)ball_y + (int)(dy * scale);
            line((int)ball_x, (int)ball_y, end_x, end_y, C_GOLD);
            circle(end_x, end_y, 4, C_GOLD, C_GOLD);
        }
    } else if (!ball_moving && !holed[current_course]) {
        int end_x = (int)ball_x + aim_dx[aim_index] * 55;
        int end_y = (int)ball_y + aim_dy[aim_index] * 55;
        for (int i = 1; i <= 8; i++) {
            int px = (int)ball_x + (end_x - (int)ball_x) * i / 9;
            int py = (int)ball_y + (end_y - (int)ball_y) * i / 9;
            circle(px, py, 2, 0xFFD9E3C6, 0xFFD9E3C6);
        }
    }

    rect(FIELD_X, FIELD_Y + FIELD_H + 8, FIELD_W, 36, C_PANEL);
    text(FIELD_X + 14, FIELD_Y + FIELD_H + 18,
         "DRAG BACK + RELEASE TO PUTT", C_MINT, 1);
    text(FIELD_X + 300, FIELD_Y + FIELD_H + 18,
         "ARROWS AIM   UP/DOWN POWER   SPACE PUTTS", C_MUTED, 1);
    rect(FIELD_X + FIELD_W - 180, FIELD_Y + FIELD_H + 17, 140, 10,
         0xFF334A3C);
    rect(FIELD_X + FIELD_W - 180, FIELD_Y + FIELD_H + 17,
         keyboard_power * 140 / 100, 10, C_GOLD);

    if (holed[current_course]) {
        rect(278, 267, 344, 112, 0xF51A3029);
        rect(278, 267, 344, 2, C_GOLD);
        centered_text(292, 282, 316, "IN THE CUP", C_MINT, 2);
        centered_text(292, 316, 316, "HOLE COMPLETE", C_INK, 1);
        draw_button(382, 340, 136, 27,
                    current_course + 1 < COURSE_COUNT ? "NEXT HOLE" : "FINAL HOLE",
                    0, 1);
    }
}

static void draw_scorecard(void) {
    rect(210, 142, 480, 372, 0xF51A3029);
    rect(210, 142, 480, 2, C_GOLD);
    text(238, 165, "ROUND SCORECARD", C_MINT, 2);
    text(242, 202, "HOLE", C_MUTED, 1);
    text(420, 202, "PAR", C_MUTED, 1);
    text(504, 202, "SCORE", C_MUTED, 1);
    text(590, 202, "+/-", C_MUTED, 1);
    int total = 0, par_total = 0;
    for (int i = 0; i < COURSE_COUNT; i++) {
        int y = 232 + i * 43;
        if (i == current_course) rect(232, y - 3, 438, 34, 0xFF284238);
        text(246, y, courses[i].name, C_INK, 1);
        number_text(432, y, courses[i].par, C_MUTED, 1);
        if (holed[i]) {
            number_text(512, y, strokes[i], C_INK, 1);
            number_text(592, y, strokes[i] - courses[i].par,
                        strokes[i] <= courses[i].par ? C_MINT : C_CORAL, 1);
        } else {
            text(512, y, "-", C_MUTED, 1);
            text(592, y, "-", C_MUTED, 1);
        }
        total += strokes[i];
        par_total += courses[i].par;
    }
    line(238, 457, 662, 457, 0xFF496453);
    text(246, 472, "TOTAL", C_GOLD, 1);
    number_text(432, 472, par_total, C_MUTED, 1);
    number_text(512, 472, total, C_INK, 1);
    number_text(592, 472, total - par_total, total <= par_total ? C_MINT : C_CORAL, 1);
    centered_text(224, 494, 452, "T OR SCORECARD TO CLOSE", C_MUTED, 1);
}

static void draw(long now) {
    draw_header();
    draw_course(now);
    if (scorecard_open) draw_scorecard();
}

static int active_zone(float x, float y, int type, const Zone** found) {
    const Course* course = &courses[current_course];
    for (int i = 0; i < course->zone_count; i++) {
        const Zone* zone = &course->zones[i];
        if (zone->type == type && inside_rect(x, y, zone->x, zone->y,
                                               zone->w, zone->h)) {
            if (found) *found = zone;
            return 1;
        }
    }
    return 0;
}

static void hit_rect(float x, float y, int rx, int ry, int rw, int rh,
                     float* vx, float* vy) {
    float px = x < rx ? (float)rx : (x > rx + rw ? (float)(rx + rw) : x);
    float py = y < ry ? (float)ry : (y > ry + rh ? (float)(ry + rh) : y);
    float dx = x - px, dy = y - py;
    float distance_sq = dx * dx + dy * dy;
    if (distance_sq >= BALL_RADIUS * BALL_RADIUS) return;
    float nx, ny, distance;
    if (distance_sq < 0.01f) {
        float left = x - rx, right = rx + rw - x;
        float top = y - ry, bottom = ry + rh - y;
        float shortest = left;
        nx = -1.0f; ny = 0.0f;
        if (right < shortest) { shortest = right; nx = 1.0f; ny = 0.0f; }
        if (top < shortest) { shortest = top; nx = 0.0f; ny = -1.0f; }
        if (bottom < shortest) { shortest = bottom; nx = 0.0f; ny = 1.0f; }
        distance = -shortest;
    } else {
        distance = square_root(distance_sq);
        nx = dx / distance;
        ny = dy / distance;
    }
    float overlap = BALL_RADIUS - distance;
    ball_x += nx * overlap;
    ball_y += ny * overlap;
    float normal_speed = *vx * nx + *vy * ny;
    if (normal_speed < 0.0f) {
        *vx -= 1.72f * normal_speed * nx;
        *vy -= 1.72f * normal_speed * ny;
    }
}

static void hit_circle(const Obstacle* obstacle, float* vx, float* vy) {
    float dx = ball_x - obstacle->x;
    float dy = ball_y - obstacle->y;
    float min_distance = (float)(BALL_RADIUS + obstacle->radius);
    float distance_sq = dx * dx + dy * dy;
    if (distance_sq >= min_distance * min_distance) return;
    float distance = square_root(distance_sq);
    float nx = distance > 0.01f ? dx / distance : 1.0f;
    float ny = distance > 0.01f ? dy / distance : 0.0f;
    ball_x = obstacle->x + nx * min_distance;
    ball_y = obstacle->y + ny * min_distance;
    float normal_speed = *vx * nx + *vy * ny;
    if (normal_speed < 0.0f) {
        *vx -= 1.82f * normal_speed * nx;
        *vy -= 1.82f * normal_speed * ny;
    }
}

static void remember_trail(void) {
    if (trail_count == MAX_TRAIL) {
        memmove(trail_x, trail_x + 1, sizeof(trail_x) - sizeof(trail_x[0]));
        memmove(trail_y, trail_y + 1, sizeof(trail_y) - sizeof(trail_y[0]));
        trail_count--;
    }
    trail_x[trail_count] = (int)ball_x;
    trail_y[trail_count] = (int)ball_y;
    trail_count++;
}

static void finish_hole(void) {
    ball_moving = 0;
    ball_vx = ball_vy = 0.0f;
    holed[current_course] = 1;
    dragging = 0;
}

static void update_ball(long now) {
    if (!ball_moving) return;
    const Course* course = &courses[current_course];
    const Zone* slope = NULL;
    (void)active_zone(ball_x, ball_y, ZONE_SLOPE, &slope);
    if (slope) {
        ball_vx += (float)slope->slope_x * 0.30f / 60.0f;
        ball_vy += (float)slope->slope_y * 0.30f / 60.0f;
    }

    ball_x += ball_vx / 60.0f;
    ball_y += ball_vy / 60.0f;
    float min_x = FIELD_X + BALL_RADIUS + 1;
    float max_x = FIELD_X + FIELD_W - BALL_RADIUS - 1;
    float min_y = FIELD_Y + BALL_RADIUS + 1;
    float max_y = FIELD_Y + FIELD_H - BALL_RADIUS - 1;
    if (ball_x < min_x) { ball_x = min_x; ball_vx = ball_vx > 0 ? ball_vx : -ball_vx * 0.72f; }
    if (ball_x > max_x) { ball_x = max_x; ball_vx = ball_vx < 0 ? ball_vx : -ball_vx * 0.72f; }
    if (ball_y < min_y) { ball_y = min_y; ball_vy = ball_vy > 0 ? ball_vy : -ball_vy * 0.72f; }
    if (ball_y > max_y) { ball_y = max_y; ball_vy = ball_vy < 0 ? ball_vy : -ball_vy * 0.72f; }

    for (int i = 0; i < course->obstacle_count; i++) {
        const Obstacle* obstacle = &course->obstacles[i];
        if (obstacle->type == OBSTACLE_BUMPER)
            hit_circle(obstacle, &ball_vx, &ball_vy);
        else
            hit_rect(ball_x, ball_y, object_x(obstacle, now), obstacle->y,
                     obstacle->w, obstacle->h, &ball_vx, &ball_vy);
    }

    if (active_zone(ball_x, ball_y, ZONE_WATER, NULL)) {
        strokes[current_course]++;
        set_ball_to_tee();
        return;
    }

    if (course->portal_radius && portal_cooldown == 0) {
        float ax = ball_x - course->portal_ax, ay = ball_y - course->portal_ay;
        float bx = ball_x - course->portal_bx, by = ball_y - course->portal_by;
        int radius_sq = course->portal_radius * course->portal_radius;
        if (ax * ax + ay * ay < radius_sq) {
            ball_x = (float)course->portal_bx;
            ball_y = (float)course->portal_by;
            portal_cooldown = 24;
        } else if (bx * bx + by * by < radius_sq) {
            ball_x = (float)course->portal_ax;
            ball_y = (float)course->portal_ay;
            portal_cooldown = 24;
        }
    }
    if (portal_cooldown > 0) portal_cooldown--;

    float hx = ball_x - course->hole_x, hy = ball_y - course->hole_y;
    if (hx * hx + hy * hy < (HOLE_RADIUS - 2) * (HOLE_RADIUS - 2) &&
        square_root(ball_vx * ball_vx + ball_vy * ball_vy) < 235.0f) {
        finish_hole();
        return;
    }

    float friction = 0.986f;
    if (active_zone(ball_x, ball_y, ZONE_SAND, NULL)) friction = 0.955f;
    else if (active_zone(ball_x, ball_y, ZONE_ROUGH, NULL)) friction = 0.975f;
    ball_vx *= friction;
    ball_vy *= friction;
    if (square_root(ball_vx * ball_vx + ball_vy * ball_vy) < 5.0f) {
        ball_vx = ball_vy = 0.0f;
        ball_moving = 0;
    }
    if (++trail_tick >= 3) {
        remember_trail();
        trail_tick = 0;
    }
}

static void shoot(float dx, float dy, float strength) {
    if (ball_moving || holed[current_course]) return;
    float length = square_root(dx * dx + dy * dy);
    if (length < 0.01f) return;
    if (strength > 540.0f) strength = 540.0f;
    if (strength < 35.0f) strength = 35.0f;
    ball_vx = dx / length * strength;
    ball_vy = dy / length * strength;
    ball_moving = 1;
    dragging = 0;
    strokes[current_course]++;
    clear_trail();
    remember_trail();
}

static void shoot_from_drag(void) {
    float dx = ball_x - mouse_x;
    float dy = ball_y - mouse_y;
    float length = square_root(dx * dx + dy * dy);
    if (length < 7.0f) return;
    shoot(dx, dy, length * 4.1f);
}

static void shoot_keyboard(void) {
    float strength = 60.0f + keyboard_power * 4.4f;
    shoot((float)aim_dx[aim_index], (float)aim_dy[aim_index], strength);
}

static int in_button(int x, int y, int bx, int by, int bw, int bh) {
    return x >= bx && y >= by && x < bx + bw && y < by + bh;
}

static void mouse_event(const syscall_window_event_t* event) {
    int x = event->x, y = event->y;
    int left = (event->buttons & SYSCALL_MOUSE_BTN_LEFT) != 0;
    if (left && !mouse_down) {
        if (scorecard_open) {
            scorecard_open = 0;
        } else if (y >= 20 && y < 56 && x >= 330 && x < 330 + COURSE_COUNT * 54) {
            select_course((x - 330) / 54);
        } else if (in_button(x, y, 624, 20, 88, 36)) {
            restart_course();
        } else if (in_button(x, y, 722, 20, 126, 36)) {
            scorecard_open = 1;
        } else if (holed[current_course] && in_button(x, y, 382, 340, 136, 27)) {
            if (current_course + 1 < COURSE_COUNT) select_course(current_course + 1);
        } else if (!ball_moving && !holed[current_course] &&
                   y >= FIELD_Y && y <= FIELD_Y + FIELD_H) {
            dragging = 1;
            mouse_x = x;
            mouse_y = y;
        }
    }
    if (left && dragging) {
        mouse_x = x;
        mouse_y = y;
    }
    if (!left && mouse_down && dragging) {
        mouse_x = x;
        mouse_y = y;
        shoot_from_drag();
        dragging = 0;
    }
    mouse_down = left;
}

static void key_event(const syscall_window_event_t* event) {
    if (!event->buttons) return;
    if (event->key == KEY_T) { scorecard_open = !scorecard_open; return; }
    if (event->key == KEY_R) { restart_course(); return; }
    if (event->key == KEY_N) {
        if (current_course + 1 < COURSE_COUNT) select_course(current_course + 1);
        return;
    }
    if (event->key == KEY_LEFT) aim_index = (aim_index + 7) % 8;
    if (event->key == KEY_RIGHT) aim_index = (aim_index + 1) % 8;
    if (event->key == KEY_UP && keyboard_power < 100) keyboard_power += 5;
    if (event->key == KEY_DOWN && keyboard_power > 10) keyboard_power -= 5;
    if (event->key == KEY_SPACE) shoot_keyboard();
}

int main(void) {
    window_id = mos_window_create(0, 130, 75, WIDTH, HEIGHT, "Greenline Mini Golf");
    if (!window_id) return 1;
    mos_window_set_resizable(window_id, false);
    syscall_window_style_t style = {
        .title_bar = 0xFF1B3029, .title_text = 0xFFF4F1E7,
        .close_button = 0xFFE78370, .minimize_button = 0xFFF1C56B,
        .maximize_button = 0xFFB9E5C8, .close_icon = 0xFFFFFFFF,
        .minimize_icon = 0xFF17211D, .maximize_icon = 0xFF17211D,
        .border = 0xFF365344, .content_background = 0xFF12211D
    };
    mos_window_set_style(window_id, style);
    pixels = (uint32_t*)malloc((size_t)WIDTH * HEIGHT * sizeof(uint32_t));
    if (!pixels) { mos_window_close(window_id); return 1; }
    set_ball_to_tee();

    long last_frame = mos_uptime();
    long accumulator = 0;
    for (;;) {
        syscall_window_event_t event;
        while (mos_window_next_event(window_id, &event) == SYS_SUCCESS) {
            if (event.type == SYSCALL_WINDOW_EVENT_CLOSE_REQUEST) {
                mos_window_close(window_id);
                return 0;
            }
            if (event.type == SYSCALL_WINDOW_EVENT_MOUSE) mouse_event(&event);
            if (event.type == SYSCALL_WINDOW_EVENT_KEY) key_event(&event);
        }

        long now = mos_uptime();
        long elapsed = now - last_frame;
        if (elapsed > 80) elapsed = 80;
        accumulator += elapsed;
        last_frame = now;
        while (accumulator >= 16) {
            update_ball(now);
            accumulator -= 16;
        }

        draw(now);
        mos_window_present(window_id, pixels, WIDTH * 4, 0, 0, WIDTH, HEIGHT);
        mos_sleep(16);
    }
}