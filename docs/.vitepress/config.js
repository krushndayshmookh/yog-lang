import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Yog',
  description: 'JS syntax meets bare metal — a systems compiler for JS developers.',

  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }],
  ],

  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'Yog',

    nav: [
      { text: 'Guide', link: '/guide/what-is-yog' },
      { text: 'Reference', link: '/reference/intrinsics' },
      { text: 'Vision', link: '/vision/js-runtime' },
      { text: 'GitHub', link: 'https://github.com/krushndayshmookh/yog' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is Yog?', link: '/guide/what-is-yog' },
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'The Yog Dialect', link: '/guide/dialect' },
            { text: 'Editor Setup', link: '/guide/editor-setup' },
          ],
        },
        {
          text: 'Compiler',
          items: [
            { text: 'yogc CLI', link: '/guide/yogc' },
            { text: 'Bootstrap & Self-Hosting', link: '/guide/bootstrap' },
          ],
        },
        {
          text: 'Targets',
          items: [
            { text: 'ARM64 (Raspberry Pi 3)', link: '/guide/targets/arm64' },
            { text: 'ESP32 (Xtensa LX6)', link: '/guide/targets/esp32' },
            { text: 'x86_64 (Linux / QEMU)', link: '/guide/targets/x86_64' },
          ],
        },
        {
          text: 'Kernel Demo (JSOS)',
          items: [
            { text: 'Hello World', link: '/guide/hello-world' },
            { text: 'UART Driver', link: '/guide/uart' },
            { text: 'Running in QEMU', link: '/guide/qemu' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Compiler Intrinsics', link: '/reference/intrinsics' },
            { text: 'ARM64 Backend', link: '/reference/arm64' },
            { text: 'ESP32 Backend', link: '/reference/esp32' },
            { text: 'x86_64 Backend', link: '/reference/x86_64' },
            { text: 'Memory Map', link: '/reference/memory-map' },
            { text: 'Syscall Table', link: '/reference/syscalls' },
          ],
        },
      ],
    },

      '/vision/': [
        {
          text: 'Vision',
          items: [
            { text: 'JS Runtime on Bare Metal', link: '/vision/js-runtime' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/krushndayshmookh/yog' },
    ],

    footer: {
      message: 'Yog — union of JS syntax and silicon.',
    },

    search: {
      provider: 'local',
    },
  },
})
