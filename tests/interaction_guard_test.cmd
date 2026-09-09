@echo off
setlocal
call "D:\AI_Workspace\ai-models\vs-build-tools\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 >nul
if errorlevel 1 exit /b 1
cl /nologo /EHsc /W4 /Fe:tests\interaction_guard_test.exe /Fo:tests\interaction_guard_test.obj tests\interaction_guard_test.cpp
if errorlevel 1 exit /b 1
tests\interaction_guard_test.exe
