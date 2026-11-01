@echo off
rem Windows-subsystem build (no console window). Build with MSVC (run from "x64 Native Tools Command Prompt for VS"). Output goes to the project root.
cd /d "%~dp0"
rc /nologo app.rc || exit /b 1
cl /nologo /std:c++17 /EHsc /O2 /MT /W3 /DUNICODE /D_UNICODE main.cpp app.res /Fe:..\PhotoshopSupremeMCP-Setup.exe /link /SUBSYSTEM:WINDOWS /ENTRY:mainCRTStartup urlmon.lib ws2_32.lib advapi32.lib shell32.lib ole32.lib user32.lib || exit /b 1
del main.obj app.res 2>nul
echo Built ..\PhotoshopSupremeMCP-Setup.exe
