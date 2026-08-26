INSERT INTO products (name, price_cents) VALUES
    ('Chaos Monkey Plush', 1899),
    ('Rubber Duck Debugger', 999),
    ('Mechanical Keyboard', 8999),
    ('Ergonomic Mouse Pad', 1499),
    ('USB-C Hub', 3499),
    ('Standing Desk Riser', 12999),
    ('Noise-Cancelling Earbuds', 7999),
    ('Sticker Pack: Postgres Elephant', 599)
ON CONFLICT DO NOTHING;
