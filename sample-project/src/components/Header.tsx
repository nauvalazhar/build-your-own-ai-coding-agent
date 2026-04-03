interface HeaderProps {
  title?: string;
}

export function Header({ title = "My App" }: HeaderProps) {
  return (
    <header className="border-b border-gray-200 px-8 py-4">
      <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
    </header>
  );
}
