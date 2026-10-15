#include <stdio.h>

struct Point {
    int x, y;
    Point() : x(0), y(0) {}
    Point(int x_, int y_) : x(x_), y(y_) {}
    int sum() const { return x + y; }
    Point operator+(const Point& o) const { return Point(x + o.x, y + o.y); }
    Point& operator+=(const Point& o) { x += o.x; y += o.y; return *this; }
    bool operator==(const Point& o) const { return x == o.x && y == o.y; }
};

class Tracer {
public:
    Tracer(const char* n) : name(n) { printf("ctor %s\n", name); ++count; }
    Tracer(const Tracer& o) : name(o.name) { printf("copy %s\n", name); ++count; }
    ~Tracer() { printf("dtor %s\n", name); --count; }
    Tracer& operator=(const Tracer& o) { printf("assign %s <- %s\n", name, o.name); return *this; }
    const char* get() const { return name; }
    static int count;
private:
    const char* name;
};
int Tracer::count = 0;

static Tracer make(const char* n) { return Tracer(n); }
static void byValue(Tracer t) { printf("byValue %s\n", t.get()); }
static void byRef(const Tracer& t) { printf("byRef %s\n", t.get()); }

class Counter {
    int n = 5;
public:
    void inc() { n++; }
    int get() const { return n; }
};

int main() {
    Point a(1, 2), b(3, 4);
    Point c = a + b;
    c += Point(10, 10);
    printf("%d %d %d %d\n", c.x, c.y, c.sum(), (int)(a == Point(1, 2)));
    {
        Tracer t1("one");
        Tracer t2 = t1;
        byRef(t1);
        byValue(t2);
        Tracer t3 = make("three");
        t3 = t1;
        printf("count %d\n", Tracer::count);
        for (int i = 0; i < 2; i++) {
            Tracer loop("loop");
            if (i == 1) break;
        }
    }
    printf("count %d\n", Tracer::count);
    Counter k;
    k.inc(); k.inc();
    printf("k %d\n", k.get());
    Point arr[3];
    arr[1] = Point(7, 8);
    printf("arr %d %d\n", arr[1].sum(), arr[0].sum());
    return 3;
}
