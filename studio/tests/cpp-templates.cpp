#include <stdio.h>
#include <string.h>

template <typename T>
T maxOf(T a, T b) { return a > b ? a : b; }

template <typename T, int N>
struct Array {
    T data[N];
    int size() const { return N; }
    T& operator[](int i) { return data[i]; }
    const T& operator[](int i) const { return data[i]; }
    T* begin() { return data; }
    T* end() { return data + N; }
};

template <typename T>
class Vector {
public:
    Vector() : items(nullptr), count(0), cap(0) {}
    Vector(const Vector& o) : items(nullptr), count(0), cap(0) { for (int i = 0; i < o.count; i++) push(o.items[i]); }
    ~Vector() { delete[] items; }
    Vector& operator=(const Vector& o) {
        if (this != &o) { count = 0; for (int i = 0; i < o.count; i++) push(o.items[i]); }
        return *this;
    }
    void push(const T& v) {
        if (count == cap) {
            int nc = cap ? cap * 2 : 4;
            T* n = new T[nc];
            for (int i = 0; i < count; i++) n[i] = items[i];
            delete[] items;
            items = n; cap = nc;
        }
        items[count++] = v;
    }
    int size() const { return count; }
    T& operator[](int i) { return items[i]; }
    T* begin() { return items; }
    T* end() { return items + count; }
private:
    T* items;
    int count, cap;
};

class String {
public:
    String(const char* s = "") { len = (int)strlen(s); buf = new char[len + 1]; memcpy(buf, s, len + 1); }
    String(const String& o) : String(o.buf) {}
    ~String() { delete[] buf; }
    String& operator=(const String& o) {
        if (this == &o) return *this;
        delete[] buf; len = o.len; buf = new char[len + 1]; memcpy(buf, o.buf, len + 1);
        return *this;
    }
    String operator+(const String& o) const {
        char* t = new char[len + o.len + 1];
        memcpy(t, buf, len); memcpy(t + len, o.buf, o.len + 1);
        String r(t); delete[] t; return r;
    }
    const char* c_str() const { return buf; }
    int length() const { return len; }
    bool operator==(const String& o) const { return strcmp(buf, o.buf) == 0; }
private:
    char* buf; int len;
};

enum class Color : unsigned char { Red = 1, Green, Blue = 10 };
enum Fruit { Apple, Pear = 5, Plum };

struct Global {
    int v;
    Global(int x) : v(x * 3) { printf("Global(%d)\n", x); }
    ~Global() {}
};
Global g1(4);
static int initCount = maxOf(3, 9);

struct Pair { int a; double b; };

struct Accum {
    int total = 0;
    Accum& add(int v) { total += v; return *this; }
    static Accum make() { Accum a; a.total = 100; return a; }
    operator int() const { return total; }
};

template <typename A, typename B>
struct Duo { A first; B second; Duo(A a, B b) : first(a), second(b) {} };

template <typename T>
T sumAll(Vector<T>& v) { T s = T(); for (auto& x : v) s = s + x; return s; }

int main() {
    printf("%d %d %c\n", maxOf(3, 7), (int)(maxOf(2.5, 1.5) * 10), maxOf('a', 'z'));
    Array<int, 4> arr;
    for (int i = 0; i < arr.size(); i++) arr[i] = i * 10;
    int tot = 0;
    for (int v : arr) tot += v;
    printf("arr %d\n", tot);
    Vector<int> vi;
    for (int i = 0; i < 10; i++) vi.push(i * i);
    Vector<int> copy = vi;
    copy[0] = 99;
    printf("vec %d %d %d %d\n", vi.size(), vi[9], copy[0], vi[0]);
    printf("sum %d\n", sumAll(vi));
    Vector<String> words;
    words.push(String("hello"));
    words.push("world");
    String joined = words[0] + String(" ") + words[1];
    printf("%s %d\n", joined.c_str(), joined.length());
    for (auto& w : words) printf("[%s]", w.c_str());
    printf("\n");
    String s2;
    s2 = joined;
    printf("eq %d\n", (int)(s2 == joined));
    Color c = Color::Blue;
    printf("color %d %d\n", (int)c, (int)Color::Green);
    Fruit f = Plum;
    printf("fruit %d\n", f);
    printf("global %d %d\n", g1.v, initCount);
    auto p = Pair{3, 2.5};
    auto q = p;
    printf("pair %d %d\n", q.a, (int)(q.b * 2));
    Accum acc;
    acc.add(1).add(2).add(3);
    int asInt = acc;
    printf("acc %d %d\n", asInt, (int)Accum::make());
    Duo<int, const char*> d(5, "five");
    printf("duo %d %s\n", d.first, d.second);
    int nums[] = {5, 3, 8};
    int best = 0;
    for (const int& n : nums) best = maxOf(best, n);
    printf("best %d\n", best);
    long l = static_cast<long>(3.9);
    unsigned char uc = static_cast<unsigned char>(300);
    printf("cast %ld %d\n", l, uc);
    bool flag = true;
    if (flag && !false) printf("bool ok %d\n", (int)sizeof(bool));
    return 0;
}
