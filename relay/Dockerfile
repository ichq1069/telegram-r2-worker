FROM python:3.11-slim

WORKDIR /app
COPY relay.py requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

EXPOSE 18088
ENV PORT=18088
ENV API_KEY=teleup2026

CMD ["python3", "relay.py"]
