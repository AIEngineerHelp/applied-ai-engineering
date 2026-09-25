from datetime import datetime

from pydantic import BaseModel


class LogRecord(BaseModel):
    ts: datetime
    dataset: str
    host_or_node: str | None
    component: str | None
    level: str | None
    content: str
    line_id: str

class BaseParser:
    def parse_line(self, line: str) -> LogRecord | None:
        raise NotImplementedError
        
    def parse_slice(self, lines: list[str]) -> list[LogRecord]:
        records = []
        for line in lines:
            record = self.parse_line(line)
            if record:
                records.append(record)
        return records
