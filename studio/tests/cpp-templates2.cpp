#include <stdio.h>

template <typename T>
class Stack {
public:
    Stack();
    ~Stack();
    void push(T v);
    T pop();
    bool empty() const { return n == 0; }
    int size() const;
private:
    T data[16];
    int n;
};
template <typename T> Stack<T>::Stack() : n(0) {}
template <typename T> Stack<T>::~Stack() { printf("~Stack %d\n", n); }
template <typename T> void Stack<T>::push(T v) { data[n++] = v; }
template <typename T> T Stack<T>::pop() { return data[--n]; }
template <typename T> int Stack<T>::size() const { return n; }

template <typename K, typename V = int>
struct Entry { K key; V value; };

template <typename T>
struct Box {
    T v;
    explicit Box(T x) : v(x) {}
};

template <typename T> T square(T x) { return x * x; }
template <typename T> void swapT(T& a, T& b) { T t = a; a = b; b = t; }
template <int N> int fact() { return N * fact<N - 1>(); }
template <> int fact<0>() { return 1; }

class Vec2 {
public:
    float x, y;
    Vec2(float x = 0, float y = 0) : x(x), y(y) {}
    Vec2 operator-() const { return Vec2(-x, -y); }
    Vec2 operator*(float k) const { return Vec2(x * k, y * k); }
    friend Vec2 operator*(float k, const Vec2& v) { return v * k; }
    bool operator<(const Vec2& o) const { return x < o.x; }
    float& operator[](int i) { return i == 0 ? x : y; }
};

struct Out {
    Out& operator<<(int v) { printf("%d", v); return *this; }
    Out& operator<<(const char* s) { printf("%s", s); return *this; }
};
Out& operator<<(Out& o, const Vec2& v) { o << "(" << (int)v.x << "," << (int)v.y << ")"; return o; }

static int apply(int (*fn)(int), int v) { return fn(v); }
static int dbl(int v) { return v * 2; }

namespace util {
    template <typename T> T clamp(T v, T lo, T hi) { return v < lo ? lo : hi < v ? hi : v; }
    struct Counter { static int next() { static int c = 0; return ++c; } };
}

int main() {
    {
        Stack<int> s;
        for (int i = 0; i < 5; i++) s.push(i * 3);
        printf("size %d\n", s.size());
        while (!s.empty()) printf("%d ", s.pop());
        printf("\n");
        Stack<Vec2> sv;
        sv.push(Vec2(1, 2));
        printf("vec %d\n", (int)sv.pop().y);
    }
    Entry<const char*> e{"k", 5};
    Entry<int, char> e2{1, 'c'};
    printf("%s %d %d %c\n", e.key, e.value, e2.key, e2.value);
    Box<int> b(4);
    printf("box %d\n", b.v);
    printf("sq %d %d\n", square(7), (int)square(1.5f * 2));
    printf("sqx %ld\n", square<long>(100000));
    int a = 1, c = 2; swapT(a, c);
    printf("swap %d %d\n", a, c);
    printf("fact %d\n", fact<5>());
    Vec2 v(3, 4);
    Vec2 w = 2.0f * -v;
    Out out;
    out << "w=" << w << " v0=" << (int)v[0] << "\n";
    v[1] = 9;
    printf("v1 %d lt %d\n", (int)v.y, (int)(w < v));
    printf("apply %d\n", apply(dbl, 21));
    printf("clamp %d %d %d\n", util::clamp(5, 0, 3), util::clamp(-5, 0, 3), util::clamp(2, 0, 3));
    util::Counter::next(); util::Counter::next();
    printf("counter %d\n", util::Counter::next());
    Stack<Stack<int>*> nested;
    printf("nested %d\n", nested.size());
    return 0;
}
