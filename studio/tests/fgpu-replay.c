// Replays a gpu.log from the Studio preview (fgpu-record.js) through the Minimal-OS kernel's
// FGPU backend (fgpu_raster.c, fgpu_shader.c) and writes every presented
// frame to kernel.raw. The command handling follows src/modules/GPU/fgpu.c.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "x86_64/fgpu_raster.h"
#include "x86_64/fgpu_shader.h"

#define MAXH 256
typedef struct { int used; uint32_t w, h, format; void* mem; } surf_t;
typedef struct { int used; uint64_t size; void* mem; } buf_t;
typedef struct { int used; uint32_t* blob; fgpu_program_t p; } prog_t;
static surf_t S[MAXH]; static buf_t B[MAXH]; static prog_t P[MAXH];

typedef struct {
    surf_t* color; surf_t* depth; fgpu_pipeline_t pipe; fgpu_layout_t layout;
    float constants[FGPU_SHADER_MAX_UNIFORMS][4];
} st_t;

static int target(st_t* st, fgpu_target_t* t) {
    memset(t, 0, sizeof(*t));
    if (!st->color && !st->depth) return 0;
    surf_t* any = st->color ? st->color : st->depth;
    t->width = any->w; t->height = any->h;
    if (st->color) { t->color = st->color->mem; t->color_pitch = st->color->w; }
    if (st->depth) { t->depth = st->depth->mem; t->depth_pitch = st->depth->w; }
    return 1;
}

static int execute(st_t* st, const uint32_t* cmd, uint32_t words) {
    uint32_t pos = 0;
    while (pos < words) {
        uint32_t op = cmd[pos] >> 16, len = cmd[pos] & 0xFFFF;
        if (!len || pos + len > words) return -1;
        const uint32_t* arg = cmd + pos + 1;
        switch (op) {
            case FGPU_OP_BIND_TARGET:
                st->color = arg[0] ? &S[arg[0]] : NULL; st->depth = arg[1] ? &S[arg[1]] : NULL;
                { surf_t* any = st->color ? st->color : st->depth;
                  if (any) { st->pipe.vp_x = st->pipe.vp_y = 0; st->pipe.vp_w = any->w; st->pipe.vp_h = any->h; } }
                break;
            case FGPU_OP_VIEWPORT:
                st->pipe.vp_x = arg[0]; st->pipe.vp_y = arg[1]; st->pipe.vp_w = arg[2]; st->pipe.vp_h = arg[3]; break;
            case FGPU_OP_CLEAR: { fgpu_target_t t; target(st, &t); float d; memcpy(&d, &arg[2], 4); fgpu_raster_clear(&t, arg[0], arg[1], d); break; }
            case FGPU_OP_SET_STATE: st->pipe.state = arg[0]; break;
            case FGPU_OP_SET_PROGRAM: st->pipe.program = arg[0]; break;
            case FGPU_OP_SET_UNIFORMS: memcpy(&st->pipe.u, arg, sizeof(fgpu_uniforms_t)); break;
            case FGPU_OP_SET_SHADER: st->pipe.shader = arg[0] ? &P[arg[0]].p : NULL; break;
            case FGPU_OP_SET_CONSTANTS: memcpy(st->constants[arg[0]], arg + 2, (size_t)arg[1] * 16); break;
            case FGPU_OP_SET_VERTEX_LAYOUT: {
                fgpu_layout_t l; memset(&l, 0, sizeof(l)); l.stride = arg[0]; l.count = arg[1];
                for (uint32_t i = 0; i < l.count; i++) l.attrib[i] = arg[2 + i];
                st->layout = l; break;
            }
            case FGPU_OP_BIND_TEXTURE: {
                fgpu_texture_t* tex = &st->pipe.textures[arg[0]]; memset(tex, 0, sizeof(*tex));
                if (!arg[1]) break;
                surf_t* s = &S[arg[1]];
                tex->pixels = s->mem; tex->width = s->w; tex->height = s->h; tex->pitch = s->w;
                tex->flags = arg[2] & (FGPU_TEXTURE_LINEAR | FGPU_TEXTURE_CLAMP);
                break;
            }
            case FGPU_OP_DRAW: {
                fgpu_draw_t d; memcpy(&d, arg, sizeof(d));
                fgpu_layout_t def; const fgpu_layout_t* layout;
                if (d.vertex_format == FGPU_VERTEX_P3N3C4) { fgpu_layout_default(&def); layout = &def; } else layout = &st->layout;
                buf_t* vb = &B[d.vertex_buffer];
                uint64_t total = vb->size / ((uint64_t)layout->stride * 4);
                const float* verts = (const float*)vb->mem + (uint64_t)d.first_vertex * layout->stride;
                uint32_t avail = (uint32_t)(total - d.first_vertex);
                fgpu_target_t t; target(st, &t);
                if (d.index_buffer) fgpu_raster_draw_layout(&t, &st->pipe, layout, verts, avail, (const uint32_t*)B[d.index_buffer].mem + d.first_index, d.index_count);
                else fgpu_raster_draw_layout(&t, &st->pipe, layout, verts, avail, NULL, d.vertex_count < avail ? d.vertex_count : avail);
                break;
            }
            default: return -1;
        }
        pos += len;
    }
    return 0;
}

int main(int argc, char** argv) {
    FILE* f = fopen(argv[1], "rb"); FILE* out = fopen(argv[2], "wb");
    uint32_t h[6];
    int frames = 0;
    while (fread(h, 4, 6, f) == 6) {
        uint8_t* data = NULL;
        if (h[5]) { data = malloc(h[5]); if (fread(data, 1, h[5], f) != h[5]) return 1; }
        switch (h[0]) {
            case 1: S[h[1]].used = 1; S[h[1]].w = h[2]; S[h[1]].h = h[3]; S[h[1]].format = h[4]; S[h[1]].mem = calloc((size_t)h[2] * h[3], 4); break;
            case 2: B[h[1]].used = 1; B[h[1]].size = h[2]; B[h[1]].mem = calloc(1, h[2] + 4); break;
            case 3: memcpy((uint8_t*)B[h[1]].mem + h[2], data, h[5]); break;
            case 4: {
                const char* why = "";
                P[h[1]].blob = (uint32_t*)data; data = NULL;
                if (!fgpu_program_check(P[h[1]].blob, h[5], &P[h[1]].p, &why)) { printf("kernel rejects program: %s\n", why); return 1; }
                break;
            }
            case 5: { surf_t* s = &S[h[1]]; for (uint32_t y = 0; y < s->h; y++) memcpy((uint8_t*)s->mem + y * s->w * 4, data + y * h[2], s->w * 4); break; }
            case 6: {
                st_t* st = calloc(1, sizeof(st_t));
                st->pipe.program = FGPU_PROGRAM_COLOR;
                st->pipe.constants = (const float (*)[4])st->constants;
                fgpu_layout_default(&st->layout);
                if (execute(st, (uint32_t*)data, h[5] / 4)) { printf("bad command buffer\n"); return 1; }
                free(st);
                break;
            }
            case 7: fwrite(S[h[1]].mem, 4, (size_t)h[2] * h[3], out); frames++; break;
        }
        free(data);
    }
    fclose(out);
    printf("kernel replayed %d frames\n", frames);
    return 0;
}
