#include <stdio.h>
#include <stdlib.h>

struct T {
    int id;
    static int live;
    T() : id(0) { live++; printf("T() %d\n", live); }
    T(int i) : id(i) { live++; printf("T(%d)\n", i); }
    T(const T& o) : id(o.id + 100) { live++; printf("T(copy %d)\n", o.id); }
    ~T() { live--; printf("~T(%d)\n", id); }
    T& operator=(const T& o) { printf("op= %d<-%d\n", id, o.id); id = o.id; return *this; }
    T operator*(int k) const { T r; r.id = id * k; return r; }
};
int T::live = 0;

struct Holder {
    T a, b;
    int n;
    Holder() : b(7), n(1) { printf("Holder\n"); }
};

struct Base { virtual ~Base() {} virtual int f() { return 1; } int g() { return f() * 10; } };
struct Mid : Base { int f() override { return 2; } };
struct Leaf : Mid { int f() override { return Mid::f() + 3; } };

static T pick(bool b) { if (b) return T(1); return T(2); }
static int takesConst(const T& t) { return t.id; }

static int counter = 0;
static int next() { return ++counter; }

int main() {
    {
        Holder h;
        printf("holder %d %d %d\n", h.a.id, h.b.id, h.n);
        Holder h2 = h;
        printf("h2 %d %d\n", h2.a.id, h2.b.id);
    }
    printf("live %d\n", T::live);
    {
        T x = T(3) * 2;
        printf("x %d\n", x.id);
        T y = pick(false);
        printf("y %d\n", y.id);
        printf("tc %d\n", takesConst(T(9)));
        printf("tc2 %d\n", takesConst(5));
        T arr[2];
        arr[0] = x;
        T* heap = new T[3];
        heap[1].id = 42;
        delete[] heap;
    }
    printf("live %d\n", T::live);
    Leaf l; Mid m; Base b;
    Base* ps[] = { &l, &m, &b };
    for (Base* p : ps) printf("v %d %d\n", p->f(), p->g());
    int a = next() + next() * 10;
    printf("order %d\n", a);
    int i = 0;
    while (true) { if (++i > 3) break; }
    switch (i) { case 4: { T s(44); printf("case4\n"); break; } default: printf("def\n"); }
    for (int k = 0; k < 3; k++) {
        T loop(k);
        if (k == 1) continue;
        printf("k %d\n", k);
    }
    printf("live %d\n", T::live);
    return T::live;
}
