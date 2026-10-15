/*
 * System info - a terminal program.
 *
 * No window: output goes to the Minimal-OS terminal through mos_write.
 * Shows the arguments, system statistics, the process list, the root
 * of the disk, and writes and reads back a file.
 */
#include "minimalos.h"
#include "stdio.h"
#include "string.h"

static long info(long op) { return mos_syscall(SYS_SYSINFO, op, 0, 0); }

int main(int argc, char** argv) {
    printf("Hello from a .run program!\n");
    for (int i = 0; i < argc; i++) printf("  argv[%d] = %s\n", i, argv[i]);

    printf("\nSystem\n");
    printf("  cores      %ld\n", info(SYS_SYSINFO_CORE_COUNT));
    printf("  cpu usage  %ld%%\n", info(SYS_SYSINFO_CPU_USAGE));
    printf("  ram        %ld MB total, %ld MB free\n",
           info(SYS_SYSINFO_RAM_TOTAL) / (1024 * 1024), info(SYS_SYSINFO_RAM_FREE) / (1024 * 1024));
    printf("  uptime     %ld ms\n", mos_uptime());

    syscall_process_info_t procs[16];
    long count = mos_pslist(procs, 16);
    printf("\nProcesses (%ld)\n", count);
    for (long i = 0; i < count; i++)
        printf("  %lu  %s%s\n", procs[i].pid, procs[i].name, procs[i].privilege == SYSCALL_PROC_PRIV_USER ? "  (user)" : "");

    syscall_dirent_t entries[32];
    long n = mos_listdir("0:/", entries, 32);
    printf("\n0:/ (%ld entries)\n", n);
    for (long i = 0; i < n; i++)
        printf("  %s%s\n", entries[i].name, entries[i].type == SYSCALL_DIRENT_TYPE_DIR ? "/" : "");

    const char* path = "0:/users/hello.txt";
    const char* message = "Written by a Studio-built program.\n";
    if (!mos_exists(path)) mos_create(path, "text", "txt");
    long fd = mos_open(path, SYS_O_RDWR);
    if (fd > 0) {
        mos_fwrite(fd, message, strlen(message));
        mos_close(fd);
    }
    char buffer[128];
    fd = mos_open(path, SYS_O_RDONLY);
    if (fd > 0) {
        long got = mos_read(fd, buffer, sizeof(buffer) - 1);
        buffer[got > 0 ? got : 0] = 0;
        mos_close(fd);
        printf("\n%s: %s", path, buffer);
    }
    printf("\nBye.\n");
    return 0;
}
