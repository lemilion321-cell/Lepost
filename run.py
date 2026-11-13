import sys
from pathlib import Path

import uvicorn

# pastiin import "config" & "app" jalan walau dijalankan dari folder lain
sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import HOST, PORT  # noqa: E402

if __name__ == "__main__":
    uvicorn.run("app.main:app", host=HOST, port=PORT, reload=False)
