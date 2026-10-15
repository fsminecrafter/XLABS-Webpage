#include <stdio.h>
struct T {
    int id;
    T(int i) : id(i) { printf("T(%d)\n", i); }
    T(const T& o) : id(o.id) { printf("copy(%d)\n", id); }
    ~T() { printf("~T(%d)\n", id); }
    int get() const { return id; }
};
static int f(const T& t) { return t.get(); }
static bool yes(const T& t) { return t.id > 0; }
int main(int argc, char**) {
    bool flag = argc > 5;
    int v = flag ? T(1).get() : T(2).get();
    printf("v %d\n", v);
    T x = flag ? T(3) : T(4);
    printf("x %d\n", x.id);
    int w = f(flag ? T(5) : T(6));
    printf("w %d\n", w);
    if (flag && yes(T(7))) printf("no\n");
    if (!flag || yes(T(8))) printf("yes\n");
    if (!flag && yes(T(9))) printf("yes9\n");
    return 0;
}
