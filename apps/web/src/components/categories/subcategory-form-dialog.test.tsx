import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SubcategoryFormDialog } from "./subcategory-form-dialog";

const createSubcategoryMock = vi.fn();
const updateSubcategoryMock = vi.fn();

vi.mock("@/lib/api/mutations", () => ({
  useApiMutation: vi.fn((group: string, op: string) => {
    if (group === "subcategories" && op === "create") {
      return { mutateAsync: createSubcategoryMock, isPending: false };
    }

    if (group === "subcategories" && op === "update") {
      return { mutateAsync: updateSubcategoryMock, isPending: false };
    }

    throw new Error(`Unexpected mutation ${group}.${op}`);
  }),
}));

const parentCategory = {
  id: "cat_1",
  name: "Food",
  type: "expense",
  icon: "utensils",
  color: "#F97316",
  isDefault: false,
  sortOrder: 0,
};

const subcategory = {
  id: "sub_1",
  categoryId: "cat_1",
  name: "Groceries",
  archived: false,
  sortOrder: 0,
};

describe("SubcategoryFormDialog", () => {
  beforeEach(() => {
    createSubcategoryMock.mockReset();
    updateSubcategoryMock.mockReset();
    createSubcategoryMock.mockResolvedValue(undefined);
    updateSubcategoryMock.mockResolvedValue(undefined);
  });

  it("creates a subcategory in create mode", async () => {
    const onOpenChange = vi.fn();

    render(
      <SubcategoryFormDialog
        open
        onOpenChange={onOpenChange}
        parentCategory={parentCategory as never}
      />,
    );

    expect(screen.getByRole("heading", { name: "Add subcategory" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Subcategory name"), {
      target: { value: "  Dining Out  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add subcategory" }));

    await waitFor(() => {
      expect(createSubcategoryMock).toHaveBeenCalledWith({
        categoryId: "cat_1",
        name: "Dining Out",
      });
    });
    expect(updateSubcategoryMock).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("prefills and updates a subcategory name in edit mode", async () => {
    const onOpenChange = vi.fn();

    render(
      <SubcategoryFormDialog
        open
        onOpenChange={onOpenChange}
        parentCategory={parentCategory as never}
        subcategory={subcategory as never}
      />,
    );

    expect(screen.getByRole("heading", { name: "Edit subcategory" })).toBeTruthy();
    expect(screen.getByDisplayValue("Groceries")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save & new" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Subcategory name"), {
      target: { value: "  Weekly groceries  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateSubcategoryMock).toHaveBeenCalledWith({
        id: "sub_1",
        name: "Weekly groceries",
      });
    });
    expect(createSubcategoryMock).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows the API error inside the dialog and keeps it open", async () => {
    const { TRPCClientError } = await import("@trpc/client");
    createSubcategoryMock.mockRejectedValue(
      TRPCClientError.from({ error: { message: "Category not found", code: -32004, data: { apiCode: "not_found", httpStatus: 404 } } } as never),
    );
    const onOpenChange = vi.fn();

    render(
      <SubcategoryFormDialog
        open
        onOpenChange={onOpenChange}
        parentCategory={parentCategory as never}
      />,
    );

    fireEvent.change(screen.getByLabelText("Subcategory name"), {
      target: { value: "Dining Out" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add subcategory" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Category not found");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("keeps create actions disabled for blank names", () => {
    render(
      <SubcategoryFormDialog
        open
        onOpenChange={vi.fn()}
        parentCategory={parentCategory as never}
      />,
    );

    fireEvent.change(screen.getByLabelText("Subcategory name"), {
      target: { value: "   " },
    });

    expect(
      screen.getByRole("button", { name: "Add subcategory" }),
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByRole("button", { name: "Save & new" }),
    ).toHaveProperty("disabled", true);
    expect(createSubcategoryMock).not.toHaveBeenCalled();
    expect(updateSubcategoryMock).not.toHaveBeenCalled();
  });
});
