import { NotepadContent } from "./notepad-content";
import { NotepadHeader } from "./notepad-header";

interface NotepadContainerProps {
  bookId: string;
}

export const NotepadContainer = ({ bookId }: NotepadContainerProps) => {
  return (
    <div className="flex h-full flex-col bg-background">
      <NotepadHeader />
      <div className="flex-1 overflow-hidden">
        <NotepadContent bookId={bookId} />
      </div>
    </div>
  );
};
