FROM python:3.11-slim

WORKDIR /app

# 依赖
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 应用代码（含 data 目录，SQLite 数据持久化到磁盘卷）
COPY . .

# 数据目录权限（SQLite 需可写）
RUN mkdir -p /app/data && chmod -R a+rw /app/data

ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080

# gunicorn 单 worker（SQLite 并发写需谨慎，单用户场景 1 worker 足够且最稳）
CMD ["gunicorn", "-w", "1", "-b", "0.0.0.0:8080", "app:app"]
