import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";

describe("FormField", () => {
  it("associates the label with the control", () => {
    render(
      <FormField label="Email address">
        <Input type="email" />
      </FormField>,
    );
    expect(screen.getByLabelText("Email address")).toHaveAttribute("type", "email");
  });

  it("describes the control with hint and error, and marks it invalid", () => {
    render(
      <FormField label="Slug" hint="Lowercase letters only" error="Slug is taken" required>
        <Input />
      </FormField>,
    );
    const input = screen.getByLabelText(/Slug/);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-required", "true");
    expect(input).toHaveAccessibleDescription("Slug is taken Lowercase letters only");
    expect(screen.getByRole("alert")).toHaveTextContent("Slug is taken");
  });

  it("is valid without an error", () => {
    render(
      <FormField label="Name" hint="Shown to teammates">
        <Input />
      </FormField>,
    );
    const input = screen.getByLabelText("Name");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).toHaveAccessibleDescription("Shown to teammates");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("passes accessibility props to a render-function child", () => {
    render(
      <FormField label="Role" error="Pick a role" id="role-field">
        {(props) => <select {...props} />}
      </FormField>,
    );
    const select = screen.getByLabelText("Role");
    expect(select).toHaveAttribute("id", "role-field");
    expect(select).toHaveAttribute("aria-describedby", "role-field-error");
    expect(select).toHaveAttribute("aria-invalid", "true");
  });
});
