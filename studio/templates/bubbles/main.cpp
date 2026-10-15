/*
 * Bubbles - a mosWM application in C++.
 *
 * Click to blow a bubble, hold the button to blow many. Bubbles drift up,
 * bounce off the walls and pop into sparks. Space clears the window.
 *
 * Shows classes, a virtual interface, a class template, operator
 * overloading, references, and new/delete; the SDK's C headers work
 * from C++ unchanged.
 */
#include "window.h"
#include "stdlib.h"
#include "stdio.h"
#include "font.h"

enum { KEY_SPACE = 44 };

// ---- a little 2D vector --------------------------------------------------
struct Vec2 {
    float x, y;
    Vec2(float x = 0, float y = 0) : x(x), y(y) {}
    Vec2 operator+(const Vec2& o) const { return Vec2(x + o.x, y + o.y); }
    Vec2 operator*(float k) const { return Vec2(x * k, y * k); }
    Vec2& operator+=(const Vec2& o) { x += o.x; y += o.y; return *this; }
};

// ---- a pixel buffer that knows how to draw a few things ------------------
class Surface {
public:
    Surface(int w, int h) : w(0), h(0), pixels(nullptr) { resize(w, h); }
    ~Surface() { delete[] pixels; }

    void resize(int nw, int nh) {
        delete[] pixels;
        w = nw; h = nh;
        pixels = new uint32_t[w * h];
    }
    int width() const { return w; }
    int height() const { return h; }
    const uint32_t* data() const { return pixels; }

    void clear(uint32_t top, uint32_t bottom) {
        for (int y = 0; y < h; y++) {
            uint32_t c = mix(top, bottom, y * 255 / (h > 1 ? h - 1 : 1));
            for (int x = 0; x < w; x++) pixels[y * w + x] = c;
        }
    }
    // a disc blended over what is already there
    void disc(Vec2 at, float r, uint32_t color, int alpha) {
        int x0 = (int)(at.x - r), x1 = (int)(at.x + r), y0 = (int)(at.y - r), y1 = (int)(at.y + r);
        float r2 = r * r;
        for (int y = y0; y <= y1; y++) {
            if (y < 0 || y >= h) continue;
            for (int x = x0; x <= x1; x++) {
                if (x < 0 || x >= w) continue;
                float dx = x - at.x, dy = y - at.y;
                float d2 = dx * dx + dy * dy;
                if (d2 > r2) continue;
                // brighter towards the rim, like a soap film
                int a = d2 > r2 * 0.7f ? alpha : alpha / 3;
                uint32_t& p = pixels[y * w + x];
                p = mix(p, color, a);
            }
        }
    }
    void text(int x, int y, const char* s, uint32_t color, int scale) {
        draw_text(pixels, w, h, x, y, s, color, scale);
    }

    static uint32_t mix(uint32_t a, uint32_t b, int t) {
        uint32_t r = (((a >> 16) & 255) * (255 - t) + ((b >> 16) & 255) * t) / 255;
        uint32_t g = (((a >> 8) & 255) * (255 - t) + ((b >> 8) & 255) * t) / 255;
        uint32_t bl = ((a & 255) * (255 - t) + (b & 255) * t) / 255;
        return 0xFF000000u | r << 16 | g << 8 | bl;
    }

private:
    int w, h;
    uint32_t* pixels;
};

// ---- things that move ------------------------------------------------------
class Sprite {
public:
    virtual ~Sprite() {}
    // returns false when the sprite is finished
    virtual bool update(const Surface& s) = 0;
    virtual void draw(Surface& s) const = 0;
    // a sprite that bursts leaves sparks behind when it finishes
    virtual bool bursts() const { return false; }
    virtual Vec2 where() const { return Vec2(); }
    virtual uint32_t tint() const { return 0; }
};

static uint32_t seed = 12345;
static float random(float lo, float hi) {
    seed = seed * 1103515245u + 12345u;
    return lo + (hi - lo) * (float)((seed >> 8) & 0xFFFF) / 65535.0f;
}

class Spark : public Sprite {
public:
    Spark(Vec2 at, uint32_t color) : pos(at), vel(random(-3, 3), random(-3, 3)), color(color), life(24) {}
    bool update(const Surface&) override {
        pos += vel;
        vel.y += 0.15f;
        return --life > 0;
    }
    void draw(Surface& s) const override { s.disc(pos, 1.5f, color, life * 10); }
private:
    Vec2 pos, vel;
    uint32_t color;
    int life;
};

class Bubble : public Sprite {
public:
    Bubble(Vec2 at) : pos(at), vel(random(-1.5f, 1.5f), random(-2.5f, -0.5f)), radius(random(10, 34)),
                      color(Surface::mix(0xFF7FDBFF, 0xFFFFB3E6, (int)random(0, 255))), age(0) { count++; }
    ~Bubble() { count--; }

    bool update(const Surface& s) override {
        pos += vel;
        vel.x *= 0.995f;
        if (pos.x < radius) { pos.x = radius; vel.x = -vel.x; }
        if (pos.x > s.width() - radius) { pos.x = s.width() - radius; vel.x = -vel.x; }
        age++;
        // a bubble pops when it reaches the top, or of old age
        return pos.y > radius && age < 600;
    }
    void draw(Surface& s) const override {
        s.disc(pos, radius, color, 200);
        s.disc(pos + Vec2(-radius * 0.35f, -radius * 0.35f), radius * 0.18f, 0xFFFFFFFF, 220);
    }
    bool bursts() const override { return true; }
    Vec2 where() const override { return pos; }
    uint32_t tint() const override { return color; }

    static int count;
private:
    Vec2 pos, vel;
    float radius;
    uint32_t color;
    int age;
};
int Bubble::count = 0;

// ---- a fixed-capacity list of owned sprites --------------------------------
template <typename T, int N>
class Pool {
public:
    Pool() : n(0) {}
    ~Pool() { clear(); }
    bool add(T* item) {
        if (n == N) { delete item; return false; }
        items[n++] = item;
        return true;
    }
    void clear() { while (n) delete items[--n]; }
    int size() const { return n; }
    T* operator[](int i) const { return items[i]; }
    // removes item i (order is not kept)
    void remove(int i) { delete items[i]; items[i] = items[--n]; }
private:
    T* items[N];
    int n;
};

// ---- the app ---------------------------------------------------------------
class App {
public:
    App() : surface(560, 360), id(0), down(false), popped(0) {}

    bool open() {
        id = mos_window_create(0, 140, 80, surface.width(), surface.height(), "Bubbles");
        return id != 0;
    }

    void run() {
        for (unsigned frame = 0;; frame++) {
            syscall_window_event_t ev;
            while (mos_window_next_event(id, &ev) == SYS_SUCCESS) {
                if (ev.type == SYSCALL_WINDOW_EVENT_CLOSE_REQUEST) { mos_window_close(id); return; }
                handle(ev);
            }
            if (down && frame % 4 == 0) sprites.add(new Bubble(mouse));
            step();
            render();
            mos_window_present(id, surface.data(), surface.width() * 4, 0, 0, surface.width(), surface.height());
            mos_sleep(16);
        }
    }

private:
    void handle(const syscall_window_event_t& ev) {
        switch (ev.type) {
            case SYSCALL_WINDOW_EVENT_RESIZED:
                surface.resize(ev.width, ev.height);
                break;
            case SYSCALL_WINDOW_EVENT_MOUSE:
                mouse = Vec2((float)ev.x, (float)ev.y);
                if ((ev.buttons & 1) && !down) sprites.add(new Bubble(mouse));
                down = (ev.buttons & 1) != 0;
                break;
            case SYSCALL_WINDOW_EVENT_KEY:
                if (ev.buttons && ev.key == KEY_SPACE) sprites.clear();
                break;
        }
    }

    void step() {
        for (int i = 0; i < sprites.size();) {
            Sprite* s = sprites[i];
            if (s->update(surface)) { i++; continue; }
            bool burst = s->bursts();
            Vec2 at = s->where();
            uint32_t tint = s->tint();
            sprites.remove(i);
            if (burst) {
                popped++;
                for (int k = 0; k < 10; k++) sprites.add(new Spark(at, tint));
            }
        }
    }

    void render() {
        surface.clear(0xFF16324F, 0xFF0B1726);
        for (int i = 0; i < sprites.size(); i++) sprites[i]->draw(surface);
        char line[64];
        int n = 0;
        appendText(line, n, "bubbles ");
        appendNumber(line, n, Bubble::count);
        appendText(line, n, "   popped ");
        appendNumber(line, n, popped);
        line[n] = 0;
        surface.text(14, 14, line, 0xFFE6F4FF, 2);
        if (!sprites.size()) surface.text(14, surface.height() - 30, "Click and hold to blow bubbles", 0xB0FFFFFF, 2);
    }

    static void appendText(char* out, int& n, const char* s) { while (*s) out[n++] = *s++; }
    static void appendNumber(char* out, int& n, int v) {
        char t[12]; int k = 0;
        do { t[k++] = (char)('0' + v % 10); v /= 10; } while (v);
        while (k) out[n++] = t[--k];
    }

    Surface surface;
    Pool<Sprite, 400> sprites;
    uint32_t id;
    Vec2 mouse;
    bool down;
    int popped;
};

int main() {
    App app;
    if (!app.open()) { printf("mosWM is not running\n"); return 1; }
    app.run();
    printf("bye\n");
    return 0;
}
