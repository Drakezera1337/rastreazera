@echo off
rem Roda o servidor do Rastreazera COM janela, para depurar (as mensagens aparecem aqui).
rem No dia a dia ele inicia sozinho com o Windows, sem janela (atalho "Rastreazera (servidor)").
rem Se ele já estiver rodando em segundo plano, rode parar.bat antes.
cd /d "%~dp0"
python server.py
pause
