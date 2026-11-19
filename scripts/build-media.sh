#!/bin/sh
# Build redistributable media tools from the upstream FFmpeg and LAME archives.
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
case "$(uname -s)" in
  Darwin) host=darwin ;;
  Linux) host=linux ;;
  *) echo 'Use macOS or Linux to build the media tools.' >&2; exit 1 ;;
esac
target=${1:-$host}
case "$target:$host:$(uname -m)" in
  darwin:darwin:arm64)
    export MACOSX_DEPLOYMENT_TARGET=13.0
    output="$project_dir/vendor/ffmpeg" ;;
  linux:linux:x86_64)
    output="$project_dir/vendor/ffmpeg/linux-x64" ;;
  win32:linux:x86_64)
    output="$project_dir/vendor/ffmpeg/win32-x64" ;;
  *) echo 'Supported builds are macOS arm64, Linux x64 and Linux x64 to Windows x64.' >&2; exit 1 ;;
esac
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/shiyin-ffmpeg-build.XXXXXX")
trap 'rm -r "$work_dir"' EXIT
mkdir -p "$project_dir/vendor/sources"
ffmpeg_version=6.1.6
ffmpeg_archive="$project_dir/vendor/sources/ffmpeg-$ffmpeg_version.tar.xz"
lame_archive="$project_dir/vendor/sources/lame-3.100.tar.gz"
fetch_source() {
  file=$1 url=$2 expected=$3
  source=$file
  if [ ! -f "$file" ]; then
    source="$work_dir/$(basename "$file")"
    curl --fail --location --retry 3 "$url" --output "$source"
  fi
  actual=$(shasum -a 256 "$source" | cut -d ' ' -f 1)
  [ "$actual" = "$expected" ] || { echo "Checksum mismatch: $source" >&2; exit 1; }
  if [ "$source" != "$file" ]; then mv "$source" "$file"; fi
}
fetch_source "$ffmpeg_archive" "https://ffmpeg.org/releases/ffmpeg-$ffmpeg_version.tar.xz" d4fcb164028dd3beee5d92c0ac72e46aac6973c75ea12dc14de07bf8f407370a
fetch_source "$lame_archive" https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e
jobs=${SHIYIN_BUILD_JOBS:-8}
lame_prefix="$work_dir/lame"
tar -xf "$lame_archive" -C "$work_dir"
cd "$work_dir/lame-3.100"
set --
if [ "$target" = win32 ]; then set -- --host=x86_64-w64-mingw32; fi
./configure --prefix="$lame_prefix" --disable-shared --enable-static --disable-frontend --disable-decoder "$@"
make -j"$jobs"
make install
tar -xf "$ffmpeg_archive" -C "$work_dir"
cd "$work_dir/ffmpeg-$ffmpeg_version"
set --
suffix=
ldflags="-L$lame_prefix/lib"
if [ "$target" = win32 ]; then
  suffix=.exe
  ldflags="$ldflags -static"
  set -- --arch=x86_64 --target-os=mingw32 --cross-prefix=x86_64-w64-mingw32- --enable-cross-compile
fi
./configure --disable-shared --enable-static --disable-doc --disable-debug --disable-autodetect \
  --disable-network --disable-ffplay --enable-libmp3lame --pkg-config-flags=--static \
  --extra-cflags="-I$lame_prefix/include" --extra-ldflags="$ldflags" "$@"
make -j"$jobs"
mkdir -p "$output"
cp "ffmpeg$suffix" "ffprobe$suffix" COPYING.LGPLv2.1 "$output/"
cp "$work_dir/lame-3.100/COPYING" "$output/LAME-COPYING"
printf '%s\n' "$ffmpeg_version" > "$output/ffmpeg-version.txt"
echo "Media tools built in $output"
