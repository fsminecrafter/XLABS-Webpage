// Loads a Studio-built main.elf the way Minimal-OS's elfloader.c does and
// runs it on Linux; Minimal-OS syscalls go through a hook slot (test builds).
#include <elf.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

uint64_t handler(uint64_t n, uint64_t a, uint64_t b, uint64_t c) {
    switch (n) {
        case 1: fwrite((void*)b, 1, c, stdout); return c;
        case 2: fflush(stdout); exit((int)(a & 255));
        case 3: return 12;
        case 4: { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return ts.tv_sec * 1000 + ts.tv_nsec / 1000000; }
        case 5: usleep(a * 1000); return 0;
        case 31:
            if (a == 1) return (uint64_t)malloc(c);
            if (a == 4) return (uint64_t)calloc(1, c);
            if (a == 2) { free((void*)b); return 0; }
            if (a == 3) return (uint64_t)realloc((void*)b, c);
            return (uint64_t)-4;
    }
    return (uint64_t)-4;
}
extern uint64_t hook_thunk(void);
__asm__(".globl hook_thunk\nhook_thunk:\n push %rbp\n mov %rsp,%rbp\n and $-16,%rsp\n mov %rdx,%rcx\n mov %rsi,%rdx\n mov %rdi,%rsi\n mov %rax,%rdi\n call handler\n leave\n ret\n");

int main(int argc, char** argv) {
    FILE* f = fopen(argv[1], "rb"); if (!f) return 99;
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t* buf = malloc(n); fread(buf, 1, n, f); fclose(f);
    Elf64_Ehdr* eh = (Elf64_Ehdr*)buf;
    if (memcmp(eh->e_ident, ELFMAG, 4) || eh->e_type != ET_DYN || eh->e_machine != EM_X86_64) { fprintf(stderr, "bad elf\n"); return 98; }
    Elf64_Phdr* ph = (Elf64_Phdr*)(buf + eh->e_phoff);
    uint64_t end = 0; Elf64_Phdr* dyn = 0; uint64_t data_va = 0;
    for (int i = 0; i < eh->e_phnum; i++) {
        if (ph[i].p_type == PT_DYNAMIC) dyn = &ph[i];
        if (ph[i].p_type != PT_LOAD) continue;
        if (ph[i].p_filesz > ph[i].p_memsz) return 97;
        if (ph[i].p_vaddr + ph[i].p_memsz > end) end = ph[i].p_vaddr + ph[i].p_memsz;
        if (ph[i].p_flags & PF_W) data_va = ph[i].p_vaddr;
    }
    uint8_t* base = mmap(0, end, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    for (int i = 0; i < eh->e_phnum; i++) if (ph[i].p_type == PT_LOAD) memcpy(base + ph[i].p_vaddr, buf + ph[i].p_offset, ph[i].p_filesz);
    int nrel = 0;
    if (dyn) {
        Elf64_Dyn* d = (Elf64_Dyn*)(base + dyn->p_vaddr);
        uint64_t ro = 0, rs = 0, re = sizeof(Elf64_Rela);
        for (; d->d_tag != DT_NULL; d++) { if (d->d_tag == DT_RELA) ro = d->d_un.d_val; if (d->d_tag == DT_RELASZ) rs = d->d_un.d_val; if (d->d_tag == DT_RELAENT) re = d->d_un.d_val; }
        for (uint64_t i = 0; ro && i < rs / re; i++) {
            Elf64_Rela* r = (Elf64_Rela*)(base + ro + i * re);
            if (ELF64_R_TYPE(r->r_info) == R_X86_64_RELATIVE) { *(uint64_t*)(base + r->r_offset) = (uint64_t)base + r->r_addend; nrel++; }
        }
    }
    *(uint64_t*)(base + data_va) = (uint64_t)hook_thunk;
    if (getenv("V")) fprintf(stderr, "image %lu bytes, %d relocations\n", end, nrel);
    char* args[] = { "0:/programs/test.run", "one", "two", 0 };
    void (*entry)(long, char**) = (void*)(base + eh->e_entry);
    setvbuf(stdout, 0, _IOFBF, 1 << 16);
    entry(3, args);
    return 96;
}
