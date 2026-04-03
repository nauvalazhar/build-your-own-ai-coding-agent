import { Button } from "./components/Button";
import { Header } from "./components/Header";

export default function App() {
  return (
    <div className="min-h-screen bg-white">
      <Header />
      <main className="max-w-2xl mx-auto p-8">
        <p className="text-gray-600 mb-4">
          Welcome to our app. Click the button below to get started.
        </p>
        <Button />
      </main>
    </div>
  );
}
