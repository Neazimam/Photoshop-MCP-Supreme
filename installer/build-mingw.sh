#!/bin/sh
# Cross-compile on Linux/macOS/MSYS2:  sudo apt install g++-mingw-w64-x86-64
set -e
cd "$(dirname "$0")"
x86_64-w64-mingw32-windres app.rc -O coff -o app.res.o
x86_64-w64-mingw32-g++ -std=c++17 -O2 -Wall -DUNICODE -D_UNICODE -static -static-libgcc -static-libstdc++ \
  main.cpp app.res.o -o ../PhotoshopSupremeMCP-Setup.exe \
  -mwindows -lurlmon -lws2_32 -ladvapi32 -lshell32 -lole32 -luser32
rm -f app.res.o
echo "Built ../PhotoshopSupremeMCP-Setup.exe"
