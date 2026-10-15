#include <stdio.h>

class Shape {
public:
    Shape(const char* n) : name(n) { printf("Shape(%s)\n", name); }
    virtual ~Shape() { printf("~Shape(%s)\n", name); }
    virtual int area() const = 0;
    virtual const char* kind() const { return "shape"; }
    void describe() const { printf("%s %s area=%d\n", kind(), name, area()); }
protected:
    const char* name;
};

class Rect : public Shape {
public:
    Rect(const char* n, int w, int h) : Shape(n), w(w), h(h) { printf("Rect\n"); }
    ~Rect() { printf("~Rect\n"); }
    int area() const override { return w * h; }
    const char* kind() const override { return "rect"; }
protected:
    int w, h;
};

class Square : public Rect {
public:
    Square(const char* n, int s) : Rect(n, s, s) {}
    const char* kind() const override { return "square"; }
};

class Circle : public Shape {
    int r;
public:
    explicit Circle(int r) : Shape("circle"), r(r) {}
    int area() const { return 3 * r * r; }
};

namespace geo {
    int scale = 2;
    int twice(int v) { return v * scale; }
    namespace inner { int thrice(int v) { return v * 3; } }
    struct Vec { int x, y; int dot(const Vec& o) const { return x * o.x + y * o.y; } };
}

static int over(int v) { return v + 1; }
static int over(double v) { return (int)(v * 10); }
static int over(const char* s) { return s[0]; }
static int over(int a, int b, int c = 100) { return a * b + c; }

static void swapRef(int& a, int& b) { int t = a; a = b; b = t; }

struct Node {
    int v; Node* next;
    Node(int v, Node* n) : v(v), next(n) {}
    ~Node() { printf("free %d\n", v); }
};

using namespace geo;

int main() {
    Shape* shapes[3];
    shapes[0] = new Rect("r", 2, 3);
    shapes[1] = new Square("s", 4);
    shapes[2] = new Circle(2);
    for (int i = 0; i < 3; i++) shapes[i]->describe();
    for (int i = 0; i < 3; i++) delete shapes[i];
    printf("%d %d %d\n", twice(5), geo::inner::thrice(4), ::geo::scale);
    Vec a{1, 2}, b{3, 4};
    printf("dot %d\n", a.dot(b));
    printf("over %d %d %d %d %d %d\n", over(1), over(1.5), over("A"), over(2, 3), over(2, 3, 4), over('a' + 0));
    int x = 1, y = 2;
    swapRef(x, y);
    printf("swap %d %d\n", x, y);
    Node* list = nullptr;
    for (int i = 0; i < 3; i++) list = new Node(i, list);
    while (list) { Node* n = list->next; delete list; list = n; }
    int* arr = new int[5];
    for (int i = 0; i < 5; i++) arr[i] = i * i;
    printf("arr %d\n", arr[4]);
    delete[] arr;
    Square* sq = new Square("arr", 1);
    Rect& rr = *sq;
    printf("%s %d\n", rr.kind(), rr.area());
    delete sq;
    return 0;
}
