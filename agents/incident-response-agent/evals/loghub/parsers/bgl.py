import csv
import io
from datetime import datetime

from .base import BaseParser, LogRecord


class BGLParser(BaseParser):
    def parse_slice_csv(self, csv_content: str) -> list[tuple[LogRecord, str]]:
        records = []
        reader = csv.DictReader(io.StringIO(csv_content))
        for row in reader:
            try:
                # BGL timestamp is unix epoch in seconds
                ts = datetime.fromtimestamp(float(row['Timestamp']))
            except (ValueError, KeyError):
                continue
                
            label = row.get('Label', '-')
            
            record = LogRecord(
                ts=ts,
                dataset="BGL",
                host_or_node=row.get('Node'),
                component=row.get('Component'),
                level=row.get('Level'),
                content=row.get('Content', ''),
                line_id=row.get('LineId', '')
            )
            records.append((record, label))
        return records

    def parse_line(self, line: str) -> LogRecord | None:
        # If we need to parse raw line, BGL starts with Label, Timestamp, Date, Node, Time...
        pass
