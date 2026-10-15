@echo off
rem Para o servidor do Rastreazera (o que roda sem janela e o aberto pelo iniciar.bat).
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe' OR Name='python.exe'\" | Where-Object { $_.CommandLine -like '*Rastreazera*server.py*' }; if ($p) { $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; 'Servidor do Rastreazera parado.' } else { 'O servidor do Rastreazera nao estava rodando.' }"
pause
