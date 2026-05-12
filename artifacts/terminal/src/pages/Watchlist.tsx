import { useState } from "react";
import { useWatchlist, useAddWatchlist, useRemoveWatchlist, useUpdateWatchlistNote } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatUsd } from "@/lib/utils";

export default function Watchlist() {
  const { data: watchlist = [] } = useWatchlist();
  const addWatchlist = useAddWatchlist();
  const removeWatchlist = useRemoveWatchlist();
  const updateNote = useUpdateWatchlistNote();

  const [newPair, setNewPair] = useState("");
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [noteValue, setNoteValue] = useState("");

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPair) return;
    addWatchlist.mutate({ pairAddress: newPair });
    setNewPair("");
  };

  const handleSaveNote = (pairAddress: string) => {
    updateNote.mutate({ pairAddress, note: noteValue });
    setEditingNote(null);
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold tracking-tight">Watchlist</h2>
      
      <Card className="p-4 border-border mb-6">
        <form onSubmit={handleAdd} className="flex gap-2">
          <Input 
            placeholder="Enter token pair address..." 
            value={newPair}
            onChange={e => setNewPair(e.target.value)}
            className="flex-1"
            data-testid="input-new-watchlist-pair"
          />
          <Button type="submit" disabled={addWatchlist.isPending} data-testid="btn-add-watchlist">
            Add to Watchlist
          </Button>
        </form>
      </Card>

      <Card className="border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Symbol</TableHead>
              <TableHead>Pair</TableHead>
              <TableHead>Note</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {watchlist.map(item => (
              <TableRow key={item.pairAddress}>
                <TableCell className="font-bold">{item.symbol || 'Unknown'}</TableCell>
                <TableCell className="font-mono text-xs">{item.pairAddress}</TableCell>
                <TableCell>
                  {editingNote === item.pairAddress ? (
                    <div className="flex gap-2">
                      <Input 
                        value={noteValue} 
                        onChange={e => setNoteValue(e.target.value)} 
                        className="h-8 text-sm"
                        autoFocus
                      />
                      <Button size="sm" onClick={() => handleSaveNote(item.pairAddress)}>Save</Button>
                    </div>
                  ) : (
                    <div 
                      className="cursor-pointer text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        setEditingNote(item.pairAddress);
                        setNoteValue(item.note || "");
                      }}
                    >
                      {item.note || "Add note..."}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="text-destructive hover:text-destructive/90"
                    onClick={() => removeWatchlist.mutate(item.pairAddress)}
                    data-testid={`btn-remove-${item.pairAddress}`}
                  >
                    Remove
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {watchlist.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                  Your watchlist is empty
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
