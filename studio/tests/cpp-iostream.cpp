#include <iostream>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>





int main(int argc, char** argv) {
    std::cout << "hello " << 42 << ' ' << -7L << " argc=" << argc << "\n";
    using namespace std;
    cout << "second line " << 3u << "\n";
    char* p = (char*)malloc(16);
    strcpy(p, "heap");
    cout << p << "\n";
    free(p);
    return 0;
}
