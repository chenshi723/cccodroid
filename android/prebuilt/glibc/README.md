# glibc 动态加载器（ld.so）

`ld-linux-aarch64.so.1` 取自 Termux 官方仓库的 `glibc` 包（版本与包的 sha256 见 `ld.json`），原样存放、未改动。
构建时 `devkit.mjs ldso` 把其中的 Termux 前缀等长改成本应用的包名，作为 `lib/arm64-v8a/libldlinux.so` 打进 APK：
targetSdk 36 只能执行 APK 原生库目录里的文件，glibc 程序要经它启动。

它必须与钉住的那版工具包里的 `libc.so.6` 出自同一次构建。钉了新工具包后，构建会发现 `ld.json` 对不上，
自动重新下载并替换这两个文件，提交即可。

许可：GNU C Library，LGPL-2.1-or-later。源码见 <https://sourceware.org/glibc/>，
Termux 构建配方见 <https://github.com/termux-pacman/glibc-packages>。
