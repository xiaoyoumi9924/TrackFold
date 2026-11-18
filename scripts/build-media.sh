#!/bin/sh
# Build from official source archives, without Homebrew runtime libraries.
set -eu
export MACOSX_DEPLOYMENT_TARGET=13.0
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work_dir=$(mktemp -d /tmp/shiyin-ffmpeg-build.XXXXXX)
mkdir -p "$project_dir/vendor/sources"
ffmpeg_archive="$project_dir/vendor/sources/ffmpeg-6.1.1.tar.xz"
lame_archive="$project_dir/vendor/sources/lame-3.100.tar.gz"
if [ ! -f "$ffmpeg_archive" ]; then curl --fail --location https://ffmpeg.org/releases/ffmpeg-6.1.1.tar.xz --output "$ffmpeg_archive"; fi
if [ ! -f "$lame_archive" ]; then curl --fail --location https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz --output "$lame_archive"; fi
tar -xf "$lame_archive" -C "$work_dir"
cd "$work_dir/lame-3.100"
./configure --prefix="$work_dir/lame" --disable-shared --enable-static --disable-frontend --disable-decoder
make -j8
make install
tar -xf "$ffmpeg_archive" -C "$work_dir"
cd "$work_dir/ffmpeg-6.1.1"
lame_prefix="$work_dir/lame"
./configure --disable-shared --enable-static --disable-doc --disable-debug --disable-autodetect \
  --disable-network --disable-ffplay --enable-libmp3lame --pkg-config-flags=--static \
  --extra-cflags="-I$lame_prefix/include" --extra-ldflags="-L$work_dir/lame/lib"
make -j8
mkdir -p "$project_dir/vendor/ffmpeg"
cp ffmpeg ffprobe COPYING.LGPLv2.1 "$project_dir/vendor/ffmpeg/"
cp "$work_dir/lame-3.100/COPYING" "$project_dir/vendor/ffmpeg/LAME-COPYING"
# Ensure outputs have no developer-machine dynamic-library dependencies.
otool -L "$project_dir/vendor/ffmpeg/ffmpeg" "$project_dir/vendor/ffmpeg/ffprobe"
echo "Build directory retained for source inspection: $work_dir"
