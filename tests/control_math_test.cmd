@echo off
setlocal
call "D:\AI_Workspace\ai-models\vs-build-tools\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 >nul
if errorlevel 1 exit /b 1
cl /nologo /EHsc /W4 /Fe:tests\control_math_test.exe /Fo:tests\control_math_test.obj tests\control_math_test.cpp
if errorlevel 1 exit /b 1
tests\control_math_test.exe
