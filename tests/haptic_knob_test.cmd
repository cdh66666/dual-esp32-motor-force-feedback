@echo off
setlocal
call "D:\AI_Workspace\ai-models\vs-build-tools\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 >nul
if errorlevel 1 exit /b 1
cl /nologo /EHsc /W4 /Fe:tests\haptic_knob_test.exe /Fo:tests\haptic_knob_test.obj tests\haptic_knob_test.cpp
if errorlevel 1 exit /b 1
tests\haptic_knob_test.exe
