import csv
import io
from datetime import datetime

from .base import BaseParser, LogRecord


class HadoopParser(BaseParser):
    def parse_slice_csv(self, csv_content: str) -> list[LogRecord]:
        records = []
        reader = csv.DictReader(io.StringIO(csv_content))
        for row in reader:
            try:
                # Date format: 2015-10-18 18:01:47,978
                dt_str = f"{row['Date']} {row['Time']}"
                ts = datetime.strptime(dt_str, "%Y-%m-%d %H:%M:%S,%f")
            except (ValueError, KeyError):
                continue
            
            record = LogRecord(
                ts=ts,
                dataset="Hadoop",
                host_or_node=None, # Hadoop logs in this dataset might not have node explicitly in all lines, or it's in the process/content
                component=row.get('Component'),
                level=row.get('Level'),
                content=row.get('Content', ''),
                line_id=row.get('LineId', '')
            )
            records.append(record)
        return records

    def parse_line(self, line: str) -> LogRecord | None:
        pass
