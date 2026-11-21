import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SubcategoryRow } from "./subcategory-row";

vi.mock("@/lib/api/mutations", () => ({
  useApiMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

const subcategory = {
  id: "sub_1",
  categoryId: "cat_1",
  name: "Groceries",
  archived: false,
  sortOrder: 0,
};

describe("SubcategoryRow", () => {
  it("opens the edit action from the dropdown", async () => {
    const onEdit = vi.fn();

    render(
      <SubcategoryRow
        subcategory={subcategory as never}
        parentColor="#F97316"
        onEdit={onEdit}
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Open Groceries actions" }),
    );
    fireEvent.click(await screen.findByText("Edit"));

    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});
