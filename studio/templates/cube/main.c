/*
 * 3D cube - a rotating, lit cube drawn with FarcadeGL, the SDK's 3D
 * library, in a mosWM window. It is MOSdesk's Cube app.
 *
 * FarcadeGL records the drawing into a command buffer and sends it to the
 * GPU interface (SYS_GPU) in one call; frames go straight into the window.
 * In the preview, Studio runs the same 3D pipeline as the Minimal-OS
 * kernel: vertex stage, clipping, rasterization, depth test, lighting and
 * FGSL shaders.
 *
 * Click the window so it has keyboard focus, then:
 *   L  next lighting: per pixel, per vertex, none, FGSL shader
 *   S  jump to the shader
 *   W  wireframe on / off
 *   Escape closes
 *
 * The shader mode draws the cube with an FGSL shader (GLSL-style code that
 * FarcadeGL compiles inside the program, and the GPU runs per pixel): a
 * texture, per-pixel lighting and a pulsing rim glow. The title bar shows
 * the mode and the frame rate.
 */
#include "farcadegl.h"
#include "window.h"
#include "string.h"

#define KEY_L 0x0F
#define KEY_S 0x16
#define KEY_W 0x1A
#define KEY_ESCAPE 0x29

enum { MODE_PHONG, MODE_GOURAUD, MODE_FLAT, MODE_SHADER, MODE_COUNT };
static const uint32_t k_programs[3] = { FGL_PROGRAM_PHONG, FGL_PROGRAM_GOURAUD, FGL_PROGRAM_COLOR };
static const char* const k_mode_names[MODE_COUNT] = { "per-pixel light", "per-vertex light", "flat", "FGSL shader" };

static volatile int g_quit;
static int g_mode = MODE_PHONG;
static int g_wire;

static const char* k_vertex_shader =
    "uniform mat4 fgl_ModelViewProjection, fgl_Model, fgl_NormalMatrix;\n"
    "attribute vec3 position; attribute vec3 normal; attribute vec4 color; attribute vec2 uv;\n"
    "varying vec3 v_world; varying vec3 v_normal; varying vec4 v_color; varying vec2 v_uv;\n"
    "void main() {\n"
    "    v_world = (fgl_Model * vec4(position, 1.0)).xyz;\n"
    "    v_normal = (fgl_NormalMatrix * vec4(normal, 0.0)).xyz;\n"
    "    v_color = color;\n"
    "    v_uv = uv;\n"
    "    gl_Position = fgl_ModelViewProjection * vec4(position, 1.0);\n"
    "}\n";

static const char* k_fragment_shader =
    "uniform sampler2D tex;\n"
    "uniform vec3 fgl_LightDirection, fgl_LightColor, fgl_Ambient, fgl_CameraPosition;\n"
    "uniform float time;\n"
    "varying vec3 v_world; varying vec3 v_normal; varying vec4 v_color; varying vec2 v_uv;\n"
    "void main() {\n"
    "    vec3 n = normalize(v_normal);\n"
    "    vec3 l = -normalize(fgl_LightDirection);\n"
    "    vec3 v = normalize(fgl_CameraPosition - v_world);\n"
    "    float diff = max(dot(n, l), 0.0);\n"
    "    float spec = pow(max(dot(n, normalize(l + v)), 0.0), 32.0) * 0.6;\n"
    "    vec3 base = v_color.rgb * texture(tex, v_uv).rgb;\n"
    "    float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);\n"
    "    vec3 glow = vec3(0.3, 0.65, 1.0) * rim * (0.6 + 0.4 * sin(time * 3.0));\n"
    "    gl_FragColor = vec4(base * (fgl_Ambient + fgl_LightColor * diff) + fgl_LightColor * spec + glow, 1.0);\n"
    "}\n";

// A 64 x 64 tile: light panel, dark frame, a diagonal stripe.
static void make_texture(uint32_t* px) {
    for (int y = 0; y < 64; y++) {
        for (int x = 0; x < 64; x++) {
            int frame = x < 5 || y < 5 || x > 58 || y > 58;
            int stripe = ((x + y) / 8) % 2 == 0 && x > 8 && x < 55 && y > 8 && y < 55;
            px[y * 64 + x] = frame ? 0xFF303844u : stripe ? 0xFFE8ECF2u : 0xFFB8C2D0u;
        }
    }
}

static void number(char* out, long v) {
    char t[24];
    int n = 0;
    do { t[n++] = (char)('0' + v % 10); v /= 10; } while (v);
    while (n) *out++ = t[--n];
    *out = '\0';
}

int main(void) {
    const uint32_t width = 560, height = 420;
    uint32_t window = mos_window_create(0, 140, 100, width, height, "Cube");
    if (!window) return 1;
    mos_window_set_resizable(window, false);

    FGLContextDesc desc;
    memset(&desc, 0, sizeof(desc));
    desc.width = width;
    desc.height = height;
    desc.window_id = window;
    desc.depth = 1;
    FGLContext* gl = fglCreateContext(&desc);
    if (!gl) { mos_window_close(window); return 1; }

    // Vertices with texture coordinates; the built-in programs use the
    // same layout.
    fglVertexLayoutUV(gl);
    FGLVertexUV cube[36];
    uint32_t count = fglMakeCubeUV(cube, 1.0f, NULL);
    FGLBuffer vb = fglCreateBuffer(gl, sizeof(cube));
    fglBufferData(gl, vb, 0, cube, sizeof(cube));

    // The shader is optional: without it, L skips the shader mode.
    static uint32_t texels[64 * 64];
    make_texture(texels);
    FGLTexture texture = fglCreateTexture(gl, 64, 64, texels);
    FGLShader* shader = fglCreateShader(gl, k_vertex_shader, k_fragment_shader);
    int u_time = fglUniformLocation(shader, "time");
    fglUniformTexture(gl, shader, fglUniformLocation(shader, "tex"), texture, FGL_TEXTURE_LINEAR);

    long start = mos_uptime(), last = start, frames = 0;
    while (!g_quit) {
        float t = (float)(mos_uptime() - start) / 1000.0f;
        fglClearColor(gl, 0.07f, 0.09f, 0.14f);
        fglClear(gl, FGL_COLOR_BUFFER_BIT | FGL_DEPTH_BUFFER_BIT);
        fglEnable(gl, FGL_DEPTH_TEST | FGL_CULL_FACE);
        if (g_wire) fglEnable(gl, FGL_WIREFRAME); else fglDisable(gl, FGL_WIREFRAME);
        if (g_mode == MODE_SHADER && shader) {
            fglUseShader(gl, shader);
            fglUniform1f(shader, u_time, t);
        } else {
            fglUseProgram(gl, k_programs[g_mode == MODE_SHADER ? 0 : g_mode]);
        }
        fglSetProjection(gl, fglPerspective(0.9f, (float)width / (float)height, 0.1f, 50.0f));
        fglSetView(gl, fglLookAt(fglVec3(0, 1.2f, 4.5f), fglVec3(0, 0, 0), fglVec3(0, 1, 0)));
        fglSetModel(gl, fglMul(fglRotate(t * 0.9f, fglVec3(0, 1, 0)),
                               fglRotate(t * 0.6f, fglVec3(1, 0, 0))));
        fglDraw(gl, vb, 0, count);
        if (fglPresent(gl) != 0) break;
        frames++;

        long now = mos_uptime();
        if (now - last >= 1000) {
            char title[80] = "Cube - ";
            char* end = title + strlen(title);
            size_t name_len = strlen(k_mode_names[g_mode]);
            memcpy(end, k_mode_names[g_mode], name_len);
            end += name_len;
            memcpy(end, " - ", 4);
            end += 3;
            number(end, frames * 1000 / (now - last));
            end += strlen(end);
            memcpy(end, " fps", 5);
            mos_window_set_title(window, title);
            frames = 0;
            last = now;
        }

        syscall_window_event_t ev;
        while (mos_window_next_event(window, &ev) == SYS_SUCCESS) {
            if (ev.type == SYSCALL_WINDOW_EVENT_CLOSE_REQUEST) g_quit = 1;
            if (ev.type == SYSCALL_WINDOW_EVENT_KEY && ev.buttons /* key down */) {
                if (ev.key == KEY_ESCAPE) g_quit = 1;
                else if (ev.key == KEY_W) g_wire = !g_wire;
                else if (ev.key == KEY_S && shader) g_mode = MODE_SHADER;
                else if (ev.key == KEY_L) {
                    g_mode = (g_mode + 1) % MODE_COUNT;
                    if (g_mode == MODE_SHADER && !shader) g_mode = MODE_PHONG;
                }
            }
        }
    }

    fglDestroyBuffer(gl, vb);
    fglDestroyShader(gl, shader);
    fglDestroyTexture(gl, texture);
    fglDestroyContext(gl);
    mos_window_close(window);
    return 0;
}
